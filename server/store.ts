// The task store: flat one-JSON-file-per-task persistence, with atomic writes
// and read-modify-write mutation. Kept generic over the record shape (and free
// of the server's wiring) so it can be unit-tested against a temp dir; index.ts
// binds these to the concrete Task type via thin wrappers.

import { mkdir, readdir, readFile, writeFile, rename, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { mapLimit } from '../shared/mapLimit'

// The minimal shape readTasks needs to order a project's records newest-first.
export type StoredRecord = { createdAt: string; updatedAt?: string }
export type StoredEntry<T> = { id: string; record: T }

// Newest first, by updatedAt, falling back to createdAt for records saved
// before that field existed.
export function newestFirst(a: StoredRecord, b: StoredRecord): number {
  return (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)
}

// One record's projection, by the id its filename carries.
export type Projected<P> = { id: string; value: P }

// A projection retained from an earlier read, with the stat it was valid for.
type Cached<P> = { mtimeMs: number; size: number; value: P }

// Enough reads in flight to overlap the disk with parsing, without starting a
// read of every file in an archive of hundreds at once.
const READ_CONCURRENCY = 32

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === 'ENOENT'

// Every *.json record in a pool, projected, in filename order; writeTask's .tmp
// files are not records. A dir or file that fails is left out, except when
// `strict`: then only one that no longer exists is (a file can move to the
// other pool mid-scan), and any other failure rejects the read.
async function readPool<P>(
  dir: string,
  project: (record: unknown, id: string) => P,
  opts: { strict?: boolean },
  prior?: Map<string, Cached<P>>,
): Promise<{ entries: Projected<P>[]; next: Map<string, Cached<P>> }> {
  const next = new Map<string, Cached<P>>()
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if (opts.strict && !isMissing(error)) throw error
    return { entries: [], next }
  }
  const skip = (error: unknown) => {
    if (opts.strict && !isMissing(error)) throw error
    return null
  }
  const entries = await mapLimit(
    names.filter((name) => name.endsWith('.json')).sort(),
    READ_CONCURRENCY,
    async (name): Promise<Projected<P> | null> => {
      const file = path.join(dir, name)
      const id = path.basename(name, '.json')
      try {
        const s = await stat(file)
        const hit = prior?.get(file)
        const value =
          hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size
            ? hit.value
            : project(JSON.parse(await readFile(file, 'utf8')), id)
        next.set(file, { mtimeMs: s.mtimeMs, size: s.size, value })
        return { id, value }
      } catch (error) {
        return skip(error)
      }
    },
  )
  return { entries: entries.filter((e) => e !== null), next }
}

// A reader of a pool (readPool) that keeps each file's projection between
// reads and reparses only files whose mtime or size changed. A pool polled
// every 2s is nearly all byte-identical from one read to the next, since at
// most a handful of its tasks are riding. A projection of just the fields a
// caller reads also keeps the rest of each record, mostly conversation, out of
// memory.
//
// Each read rebuilds its directory's map from that read's readdir, so a file
// archived or removed is not carried forward; there is no cap, because a cap
// below a pool's file count would evict precisely what the next read needs.
//
// This stays a function of what is on disk — no write-through, no invalidation
// protocol, and an edit made outside the server is still picked up. The one
// case it cannot see is a write that lands an identical mtime AND an identical
// size (`cp -p`, `touch -r`), or a filesystem whose stat is attribute-cached
// (NFS) rather than local. Projections are shared between reads, so callers
// must not mutate them.
export function retainedProjection<P>(
  project: (record: unknown, id: string) => P,
  opts: { strict?: boolean } = {},
): (dir: string) => Promise<Projected<P>[]> {
  const retained = new Map<string, Map<string, Cached<P>>>()
  return async (dir) => {
    const { entries, next } = await readPool(dir, project, opts, retained.get(dir))
    retained.set(dir, next)
    return entries
  }
}

// Every record in a project's data dir, parsed afresh, newest first.
// Unreadable or invalid files are skipped rather than aborting the listing.
// Nothing is kept between calls: a pool read repeatedly wants a
// retainedProjection of the fields it needs.
export async function readTaskEntries<T extends StoredRecord>(
  dataDir: string,
): Promise<StoredEntry<T>[]> {
  const { entries } = await readPool(dataDir, (record) => record as T, {})
  return entries
    .map(({ id, value }) => ({ id, record: value }))
    .sort((a, b) => newestFirst(a.record, b.record))
}

export async function readTasks<T extends StoredRecord>(
  dataDir: string,
): Promise<T[]> {
  return (await readTaskEntries<T>(dataDir)).map((entry) => entry.record)
}

// Read a single record by id, or null if it's missing/unreadable. The
// null-as-existence-probe is load-bearing: callers use it to fall back across
// the tasks/ and archived/ dirs rather than error.
export async function readTask<T>(
  dataDir: string,
  id: string,
): Promise<T | null> {
  try {
    // Opening `id.json` is not an exact-name check on case-insensitive filesystems.
    // Verify directory membership byte-for-byte first, then verify the body's id
    // when present. Legacy pre-backfill records may omit it.
    const filename = `${id}.json`
    if (!(await readdir(dataDir)).includes(filename)) return null
    const raw = await readFile(path.join(dataDir, `${id}.json`), 'utf8')
    const value = JSON.parse(raw) as T & { id?: unknown }
    if (value.id !== undefined && value.id !== id) return null
    return value as T
  } catch {
    return null
  }
}

export type WriteObserver = (file: string, value: unknown) => void
const writeObservers = new Set<WriteObserver>()

export function observeWrites(observer: WriteObserver): () => void {
  writeObservers.add(observer)
  return () => writeObservers.delete(observer)
}

// Write a record atomically: serialize to a unique temp file, then rename over
// the target. The rename is atomic on POSIX, so the 2s UI poll never reads a
// half-written file mid-stream, and concurrent writes don't collide on the temp
// path. Pretty-printed so the on-disk records stay human-readable.
export async function writeTask<T>(file: string, task: T): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(task, null, 2))
  await rename(tmp, file)
  for (const observer of writeObservers) {
    try {
      observer(file, task)
    } catch (error) {
      console.error('task store write observer failed:', error)
    }
  }
}

// Queues of in-flight mutations, one per lock key: the caller's key for a task
// record (one key per task, whichever pool its file is in), the file path for
// mutateJson. All task-JSON writes happen in this single server process, so
// chaining each key's read-modify-writes onto one promise makes the whole
// read→modify→write atomic with respect to every other writer under that key.
const chains = new Map<string, Promise<unknown>>()

// Read-modify-write a record under a single fresh read, so a streaming update
// never clobbers a concurrent edit to another field made via the HTTP endpoints
// while a turn is running. Throws if the file is missing/invalid (callers that
// tolerate that wrap the call). The read and the write each await I/O (the read
// a file, the write a rename), so two overlapping calls would otherwise both
// read before either writes and the second would lose the first writer's
// update. We serialize them per key: each call runs only after the prior
// mutation under the same key has settled, then reads fresh.
export function mutateTask<T>(
  file: string,
  fn: (task: T) => void,
  opts: { key: string; afterCommit?: (task: T) => void },
): Promise<void> {
  return withMutationLock(opts.key, () => applyMutation<T>(file, fn, opts.afterCommit))
}

export function withMutationLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = chains.get(key) ?? Promise.resolve()
  // Sequence after the prior op whether it resolved or rejected, so one failed
  // mutation doesn't wedge the key's queue.
  const run = prior.then(fn, fn)
  // The tail swallows outcomes so the next waiter only sequences on it; the
  // caller still observes this op's real result/error via `run`. Drop the map
  // entry once this op is the queue's tail, so it doesn't grow without bound.
  const tail = run.then(
    () => {},
    () => {},
  )
  chains.set(key, tail)
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return run
}

// Read-modify-write a JSON file that may not exist yet, so a record whose absence
// is its initial state (the hook approval store) gets the same atomicity as a
// task without a create-then-mutate dance that two callers could race. Returns
// the committed value.
export function mutateJson<T>(
  file: string,
  initial: () => T,
  fn: (value: T) => void,
): Promise<T> {
  return withMutationLock(file, () => applyJsonMutation<T>(file, initial, fn))
}

async function applyJsonMutation<T>(
  file: string,
  initial: () => T,
  fn: (value: T) => void,
): Promise<T> {
  let value: T
  try {
    value = JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    // Missing or unreadable both start from the initial value. A corrupt file is
    // deliberately overwritten rather than made fatal: this store's contents are
    // re-derivable (a trust-root pair rescans; a content approval is re-granted),
    // and a parse error that wedged every write would be worse than losing them.
    value = initial()
  }
  fn(value)
  // The per-project data dir exists once a task has been created there, which is
  // not a precondition for approving a hook.
  await mkdir(path.dirname(file), { recursive: true })
  await writeTask(file, value)
  return value
}

async function applyMutation<T>(
  file: string,
  fn: (task: T) => void,
  afterCommit?: (task: T) => void,
): Promise<void> {
  const task = JSON.parse(await readFile(file, 'utf8')) as T
  fn(task)
  await writeTask(file, task)
  afterCommit?.(task)
}
