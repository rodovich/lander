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

// Per-file queue of in-flight mutations, keyed by file path. All task-JSON
// writes happen in this single server process, so chaining each file's
// read-modify-writes onto one promise makes the whole read→modify→write atomic
// with respect to every other writer to the same file.
const chains = new Map<string, Promise<unknown>>()

// Read-modify-write a record under a single fresh read, so a streaming update
// never clobbers a concurrent edit to another field made via the HTTP endpoints
// while a turn is running. Throws if the file is missing/invalid (callers that
// tolerate that wrap the call). The read and the write each await I/O (the read
// a file, the write a rename), so two overlapping calls would otherwise both
// read before either writes and the second would lose the first writer's
// update. We serialize them per file: each call runs only after the prior
// mutation of the same file has fully committed, then reads fresh.
export function mutateTask<T>(
  file: string,
  fn: (task: T) => void,
): Promise<void> {
  const prior = chains.get(file) ?? Promise.resolve()
  // Sequence after the prior op whether it resolved or rejected, so one failed
  // mutation doesn't wedge the file's queue.
  const run = prior.then(
    () => applyMutation<T>(file, fn),
    () => applyMutation<T>(file, fn),
  )
  // The tail swallows outcomes so the next waiter only sequences on it; the
  // caller still observes this op's real result/error via `run`. Drop the map
  // entry once this op is the queue's tail, so it doesn't grow without bound.
  const tail = run.then(
    () => {},
    () => {},
  )
  chains.set(file, tail)
  void tail.then(() => {
    if (chains.get(file) === tail) chains.delete(file)
  })
  return run
}

async function applyMutation<T>(
  file: string,
  fn: (task: T) => void,
): Promise<void> {
  const task = JSON.parse(await readFile(file, 'utf8')) as T
  fn(task)
  await writeTask(file, task)
}
