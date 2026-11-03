import type { CheckMeta } from '../../server/protocol'

export type CheckCtx = {
  // The checkout of the task that armed the watch.
  cwd: string
  signal: AbortSignal
}

export type CheckResult =
  | { fired: false; state: unknown }
  | { fired: true; state: unknown; message: string }

export type BundledCheck = {
  meta: CheckMeta
  run: (
    ctx: CheckCtx,
    args: Record<string, string>,
    prevState: unknown,
  ) => Promise<CheckResult>
}

// Thrown by a check whose error will not go away on a later run.
export class PermanentCheckError extends Error {}
