import type { WatcherMeta } from '../../server/protocol'
import type { GitHub } from './github'

export type WatcherCtx = {
  // The checkout of the task that armed the watch.
  cwd: string
  signal: AbortSignal
  github: GitHub
}

export type WatcherResult =
  | { fired: false; state: unknown }
  | { fired: true; state: unknown; message: string }

export type BundledWatcher = {
  meta: WatcherMeta
  run: (
    ctx: WatcherCtx,
    args: Record<string, string>,
    prevState: unknown,
  ) => Promise<WatcherResult>
}

// Thrown by a watcher whose error will not go away on a later run.
export class PermanentWatcherError extends Error {}
