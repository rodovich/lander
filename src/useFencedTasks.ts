import { useCallback, useRef, useState } from 'react'
import {
  admitTask as admitToFence,
  beginTaskPatch,
  createTaskMutationFence,
  insertTask,
  mergeTaskRefresh,
  patchTask,
  removeTask,
  replaceTask,
  settleTaskPatch,
  settleTaskRemoval,
  type TaskMutationHandle,
  type TaskPatch,
} from './taskMutationFence'
import type { TaskWithProject } from './types'

// The client's copy of the tasks it is showing. Task writes are optimistic
// while polls run independently, so the fence covers only the task being
// written: stale snapshots cannot roll it back, while changes to every other
// task still land normally. The operations below are the only writers of
// `tasks`; setTasks stays private so no optimistic write can skip the fence.
export function useFencedTasks() {
  const [tasks, setTasks] = useState<TaskWithProject[]>([])

  // Latest tasks, for callbacks that outlive the render that scheduled them.
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  const fenceRef = useRef(createTaskMutationFence())
  const beginTaskMutation = useCallback(
    (task: TaskWithProject, patch: TaskPatch): TaskMutationHandle => {
      const handle = beginTaskPatch(fenceRef.current, task, patch)
      setTasks((prev) => patchTask(prev, handle.key, patch))
      return handle
    },
    [],
  )
  const finishTaskMutation = useCallback(
    (handle: TaskMutationHandle, updated?: TaskWithProject) => {
      const replacement = settleTaskPatch(fenceRef.current, handle, updated)
      if (replacement)
        setTasks((prev) => replaceTask(prev, handle.key, replacement))
    },
    [],
  )
  // The same fence for a write that takes a task out of the displayed list (an
  // archive or restore): drop the row at once, keep polls that predate the
  // write from bringing it back, and reinstate it if the write fails.
  const beginTaskRemoval = useCallback(
    (task: TaskWithProject): TaskMutationHandle => {
      const handle = beginTaskPatch(fenceRef.current, task, 'removed')
      setTasks((prev) => removeTask(prev, handle.key))
      return handle
    },
    [],
  )
  const finishTaskRemoval = useCallback(
    (handle: TaskMutationHandle, succeeded: boolean) => {
      const reinstated = settleTaskRemoval(fenceRef.current, handle, succeeded)
      if (reinstated) setTasks((prev) => insertTask(prev, reinstated))
    },
    [],
  )
  // The fence boundary is set outside the state updater, which may run twice
  // under StrictMode.
  const admit = useCallback((task: TaskWithProject) => {
    admitToFence(fenceRef.current, task)
    setTasks((prev) => insertTask(prev, task))
  }, [])

  const beginRefresh = useCallback(() => {
    const issuedAt = fenceRef.current.clock
    return (incoming: (current: TaskWithProject[]) => TaskWithProject[]) =>
      setTasks((current) =>
        mergeTaskRefresh(fenceRef.current, issuedAt, current, incoming(current)),
      )
  }, [])

  return {
    tasks,
    tasksRef,
    beginTaskMutation,
    finishTaskMutation,
    beginTaskRemoval,
    finishTaskRemoval,
    admit,
    beginRefresh,
  }
}
