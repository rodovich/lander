import { taskKeyOf } from './taskRef'
import type { TaskWithProject } from './types'

export type TaskPatch = Partial<TaskWithProject>

export type TaskMutationHandle = {
  key: string
  token: number
}

type PendingTaskMutation = {
  token: number
  patch: TaskPatch
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
  patch: TaskPatch,
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

// Merge a server snapshot task by task. A request issued before the latest
// local mutation boundary may update unrelated tasks but not this one. A
// request issued while the mutation is pending contributes fresh server fields
// beneath the optimistic patch and becomes the rollback base if the write fails.
export function mergeTaskRefresh(
  fence: TaskMutationFence,
  issuedAt: number,
  current: TaskWithProject[],
  incoming: TaskWithProject[],
): TaskWithProject[] {
  const currentByKey = new Map(current.map((task) => [taskKeyOf(task), task]))
  const incomingKeys = new Set<string>()
  const merged = incoming.map((task) => {
    const key = taskKeyOf(task)
    incomingKeys.add(key)
    if ((fence.boundaryByKey.get(key) ?? 0) > issuedAt)
      return currentByKey.get(key) ?? task

    const pending = fence.pendingByKey.get(key)
    if (!pending) return task
    pending.base = task
    return { ...task, ...pending.patch }
  })

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
