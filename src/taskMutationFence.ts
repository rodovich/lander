import { taskKeyOf } from './taskRef'
import type { TaskWithProject } from './types'

export type TaskPatch = Partial<TaskWithProject>

export type TaskMutationHandle = {
  key: string
  token: number
}

type PendingTaskMutation = {
  token: number
  // The optimistic patch, or `removed` for a write that takes the task out of
  // the displayed list (an archive or restore).
  patch: TaskPatch | 'removed'
  base: TaskWithProject
}

// Client mutations and list refreshes run independently. This fence lets a
// refresh update every unaffected task while preventing its snapshot of one
// locally-mutating task from rolling that task backward.
export type TaskMutationFence = {
  clock: number
  boundaryByKey: Map<string, number>
  pendingByKey: Map<string, PendingTaskMutation>
}

export function createTaskMutationFence(): TaskMutationFence {
  return {
    clock: 0,
    boundaryByKey: new Map(),
    pendingByKey: new Map(),
  }
}

// Mark the beginning of a task-local mutation. A second mutation of the same
// task supersedes the first optimistic patch but keeps the last authoritative
// base, so a refusal can still roll back behind both speculative states.
export function beginTaskPatch(
  fence: TaskMutationFence,
  task: TaskWithProject,
  patch: TaskPatch | 'removed',
): TaskMutationHandle {
  const key = taskKeyOf(task)
  const prior = fence.pendingByKey.get(key)
  const token = ++fence.clock
  fence.boundaryByKey.set(key, token)
  fence.pendingByKey.set(key, {
    token,
    patch,
    base: prior?.base ?? task,
  })
  return { key, token }
}

export function patchTask(
  tasks: TaskWithProject[],
  key: string,
  patch: TaskPatch,
): TaskWithProject[] {
  return tasks.map((task) =>
    taskKeyOf(task) === key ? { ...task, ...patch } : task,
  )
}

export function replaceTask(
  tasks: TaskWithProject[],
  key: string,
  replacement: TaskWithProject,
): TaskWithProject[] {
  return tasks.map((task) =>
    taskKeyOf(task) === key ? replacement : task,
  )
}

export function removeTask(
  tasks: TaskWithProject[],
  key: string,
): TaskWithProject[] {
  return tasks.filter((task) => taskKeyOf(task) !== key)
}

// Merge a server snapshot task by task. A request issued before the latest
// local mutation boundary may update unrelated tasks but not this one — not
// even to bring back a task removed locally. A request issued while the
// mutation is pending contributes fresh server fields beneath the optimistic
// patch (or, for a pending removal, stays hidden) and becomes the rollback base
// if the write fails.
export function mergeTaskRefresh(
  fence: TaskMutationFence,
  issuedAt: number,
  current: TaskWithProject[],
  incoming: TaskWithProject[],
): TaskWithProject[] {
  const currentByKey = new Map(current.map((task) => [taskKeyOf(task), task]))
  const incomingKeys = new Set<string>()
  const merged: TaskWithProject[] = []
  for (const task of incoming) {
    const key = taskKeyOf(task)
    incomingKeys.add(key)
    const prev = currentByKey.get(key)
    if ((fence.boundaryByKey.get(key) ?? 0) > issuedAt) {
      if (prev) merged.push(prev)
      continue
    }

    const pending = fence.pendingByKey.get(key)
    if (!pending) {
      merged.push(task)
      continue
    }
    pending.base = task
    if (pending.patch !== 'removed')
      merged.push({ ...pending.base, ...pending.patch })
  }

  // A snapshot begun before a mutation can also omit its task (for example,
  // around a pool move). Preserve only locally-invalidated omissions; every
  // ordinary omission remains authoritative.
  for (const task of current) {
    const key = taskKeyOf(task)
    if (
      !incomingKeys.has(key) &&
      (fence.boundaryByKey.get(key) ?? 0) > issuedAt
    )
      merged.push(task)
  }
  return merged
}

// Admit a task the client learned of from a write's own answer — the POST that
// created it — without waiting for a poll to carry it. There is no optimistic
// phase to open, so this sets only the closing boundary settleTaskPatch would:
// a refresh issued before this moment cannot know the task, and mergeTaskRefresh
// keeps a locally-invalidated omission, so the row survives until a later poll
// brings the server's own copy. The list edit itself is insertTask.
export function admitTask(
  fence: TaskMutationFence,
  task: TaskWithProject,
): void {
  fence.boundaryByKey.set(taskKeyOf(task), ++fence.clock)
}

export function insertTask(
  tasks: TaskWithProject[],
  task: TaskWithProject,
): TaskWithProject[] {
  const key = taskKeyOf(task)
  return [task, ...tasks.filter((t) => taskKeyOf(t) !== key)]
}

// Close the latest mutation of a task. Success supplies the authoritative task
// returned by the write; failure omits it and restores the newest server base
// seen beneath the overlay. The closing boundary also protects that result from
// any refresh that began while the write was in flight.
export function settleTaskPatch(
  fence: TaskMutationFence,
  handle: TaskMutationHandle,
  updated?: TaskWithProject,
): TaskWithProject | null {
  const pending = fence.pendingByKey.get(handle.key)
  if (!pending || pending.token !== handle.token) return null
  fence.boundaryByKey.set(handle.key, ++fence.clock)
  fence.pendingByKey.delete(handle.key)
  return updated ?? pending.base
}

// Close the latest removal of a task. Success leaves it removed — the closing
// boundary keeps any refresh that began while the write was in flight from
// bringing it back — and returns null; failure returns the newest server base
// to reinstate.
export function settleTaskRemoval(
  fence: TaskMutationFence,
  handle: TaskMutationHandle,
  succeeded: boolean,
): TaskWithProject | null {
  const base = settleTaskPatch(fence, handle)
  return succeeded ? null : base
}
