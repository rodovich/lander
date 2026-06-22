// The task store: flat one-JSON-file-per-task persistence, with atomic writes
// and read-modify-write mutation. Kept generic over the record shape (and free
// of the server's wiring) so it can be unit-tested against a temp dir; index.ts
// binds these to the concrete Task type via thin wrappers.

import { readdir, readFile, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

// The minimal shape readTasks needs to order a project's records newest-first.
export type StoredRecord = { createdAt: string; updatedAt?: string }

// Read and parse every *.json record in a project's data dir, newest first
// (by updatedAt, falling back to createdAt for records saved before that field
// existed). A missing dir yields []; unreadable or invalid files are skipped
// rather than aborting the listing — and non-.json entries (e.g. the
// <id>.json.<uuid>.tmp files that briefly exist mid-write) are ignored.
export async function readTasks<T extends StoredRecord>(
  dataDir: string,
): Promise<T[]> {
  let names: string[]
  try {
    names = await readdir(dataDir)
  } catch {
    return []
  }
  const tasks: T[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readFile(path.join(dataDir, name), 'utf8')
      tasks.push(JSON.parse(raw) as T)
    } catch {
      // skip unreadable/invalid files
    }
  }
  tasks.sort((a, b) =>
    (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
  )
  return tasks
}

// Read a single record by id, or null if it's missing/unreadable. The
// null-as-existence-probe is load-bearing: callers use it to fall back across
// the tasks/ and archived/ dirs rather than error.
export async function readTask<T>(
  dataDir: string,
  id: string,
): Promise<T | null> {
  try {
    const raw = await readFile(path.join(dataDir, `${id}.json`), 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// Write a record atomically: serialize to a unique temp file, then rename over
// the target. The rename is atomic on POSIX, so the 2s UI poll never reads a
// half-written file mid-stream, and concurrent writes don't collide on the temp
// path. Pretty-printed so the on-disk records stay human-readable.
export async function writeTask<T>(file: string, task: T): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(task, null, 2))
  await rename(tmp, file)
}

// Read-modify-write a record under a single fresh read, so a streaming update
// never clobbers a concurrent edit to another field made via the HTTP endpoints
// while a turn is running. Throws if the file is missing/invalid (callers that
// tolerate that wrap the call). Correctness of the read-modify-write assumes a
// single writer per file — the server enforces this with its per-task run guard.
export async function mutateTask<T>(
  file: string,
  fn: (task: T) => void,
): Promise<void> {
  const task = JSON.parse(await readFile(file, 'utf8')) as T
  fn(task)
  await writeTask(file, task)
}
