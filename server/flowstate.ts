// The pure consumer for a flow's durable-state patches: how a `state-patch` batch
// mutates a task's opaque `flowState` blob, decoupled from where the patch comes
// from (a daemon→server WS message today). Like apply.ts, this does no I/O and only
// mutates the passed task in place, and is kept import-light (protocol types only)
// so the run loop can call it inside its serialized task mutation.
//
// No producer exists in step 1 (reader-before-writer): the substrate lands inert so
// a later flow port (step 3) can emit patches without a second protocol change.

import type { StatePatchOp } from './protocol'

// The slice of a task these functions read and write. index.ts's full Task
// satisfies this structurally, so it can pass its own value without conversion.
export type StatePatchTask = {
  // The flow's opaque durable state — its decisions/identities/user-visible
  // progress (the PR number, the CI run id, the phase); bulk goes to scratch or
  // artifacts. Absent until a flow first writes it.
  flowState?: Record<string, unknown>
  // Increments once per applied `state-patch` op batch (the doc's revision
  // counter). Absent until the first write.
  flowStateRev?: number
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Apply one op to `root` (the flowState tree). `path` walks into it, creating
// intermediate objects for anything the path passes through that isn't already an
// object. The leaf op mirrors the ctx.state surface.
function applyOp(root: Record<string, unknown>, { op, path, value }: StatePatchOp): void {
  // Root-level ops (empty path) operate on the whole blob. delete/push at the root
  // are meaningless — ignore them.
  if (path.length === 0) {
    if (op === 'patch' && isObject(value)) Object.assign(root, value)
    else if (op === 'set' && isObject(value)) {
      for (const k of Object.keys(root)) delete root[k]
      Object.assign(root, value)
    }
    return
  }
  // Navigate to the parent container, creating intermediate objects as needed.
  let node = root
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    const next = node[key]
    if (isObject(next)) node = next
    else node = node[key] = {}
  }
  const leaf = path[path.length - 1]
  switch (op) {
    case 'set':
      node[leaf] = value
      break
    case 'delete':
      delete node[leaf]
      break
    case 'push': {
      const arr = node[leaf]
      if (Array.isArray(arr)) arr.push(value)
      else node[leaf] = [value]
      break
    }
    case 'patch': {
      const target = node[leaf]
      // Shallow object merge; replace-if-not-object (the target was never an object,
      // so there's nothing to merge into).
      if (isObject(target) && isObject(value)) Object.assign(target, value)
      else node[leaf] = value
      break
    }
  }
}

// Fold a `state-patch` batch onto the task's flowState, creating the blob on first
// write and stamping the producer's post-op revision. No-ops a batch at or below
// the current revision, so a producer re-sending buffered patches on resume-from is
// idempotent. Mutates the task in place.
export function applyStatePatch(
  task: StatePatchTask,
  ops: StatePatchOp[],
  rev: number,
): void {
  if (task.flowStateRev !== undefined && rev <= task.flowStateRev) return
  const root = (task.flowState ??= {})
  for (const op of ops) applyOp(root, op)
  task.flowStateRev = rev
}
