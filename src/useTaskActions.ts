import { useCallback, useState } from 'react'
import { uiHeaders } from './api'
import { latestUpdateAt } from './taskMeta'
import { taskKeyOf } from './taskRef'
import type { TaskAction } from './taskActions'
import type { TaskMutationHandle, TaskPatch } from './taskMutationFence'
import type { TaskWithProject } from './types'

// The fetch-and-reconcile task actions: optimistic local updates, the API
// call, and a refresh() where the server's answer matters. Every action is
// useCallback-stable (the rare exceptions depend only on their own in-flight
// state), and the ones acting on "the open task" read it through `currentRef`
// at call time rather than closing over a render's copy — both so memoized
// panes receiving these as props don't re-render on unrelated App state.
export function useTaskActions(opts: {
  // The open task, maintained by App each render (assigned after selection is
  // derived, read only from event handlers and effects).
  currentRef: { current: TaskWithProject | null }
  // Latest tasks readable from timer callbacks that outlive the render that
  // scheduled them (the seen-marker dwell timer marks a task seen 2s later).
  tasksRef: { current: TaskWithProject[] }
  setTasks: React.Dispatch<React.SetStateAction<TaskWithProject[]>>
  refresh: () => Promise<void>
  beginTaskMutation: (
    task: TaskWithProject,
    patch: TaskPatch,
  ) => TaskMutationHandle
  finishTaskMutation: (
    handle: TaskMutationHandle,
    updated?: TaskWithProject,
  ) => void
  setError: (message: string | null) => void
}) {
  const {
    currentRef,
    tasksRef,
    setTasks,
    refresh,
    beginTaskMutation,
    finishTaskMutation,
    setError,
  } = opts

  // Tasks with an ask answer in flight, keyed by project + task id, mirroring the send
  // path's per-task disabling.
  const [answeringBy, setAnsweringBy] = useState<Record<string, boolean>>({})
  // The task whose title is being regenerated, if any.
  const [retitling, setRetitling] = useState<string | null>(null)

  // Mark a task caught-up: advance its server-side `seenAt` to its latest
  // completed update, which clears its unseen dot. Optimistically advances the
  // local copy so the dot clears at once; the 2s poll reconciles. The server
  // stores the marker monotonically, so a stale/older value never moves it back.
  // Reads tasksRef so a delayed (dwell-timer) call sees the freshest data.
  const markSeen = useCallback(
    async (key: string) => {
      const task = tasksRef.current.find((t) => taskKeyOf(t) === key)
      if (!task) return
      const id = task.id
      const at = latestUpdateAt(task)
      if (!at || (task.seenAt && task.seenAt >= at)) return
      setTasks((prev) =>
        prev.map((t) => (taskKeyOf(t) === key ? { ...t, seenAt: at } : t)),
      )
      try {
        await fetch(`/api/${task.projectSlug}/tasks/${id}/seen`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ at }),
        })
      } catch {
        // best-effort; a later dwell or the poll will retry the mark
      }
    },
    [tasksRef, setTasks],
  )

  // Mark a task unread: reset its server-side `seenAt` so the task's latest
  // update reads as unviewed again, re-showing its dot. Optimistically clears
  // the local marker so the dot appears at once; the 2s poll reconciles. The
  // next time the viewer reads the task, markSeen advances the marker forward
  // again.
  const markUnread = useCallback(
    async (key: string) => {
      const task = tasksRef.current.find((t) => taskKeyOf(t) === key)
      if (!task) return
      const id = task.id
      setTasks((prev) =>
        prev.map((t) => (taskKeyOf(t) === key ? { ...t, seenAt: '' } : t)),
      )
      try {
        await fetch(`/api/${task.projectSlug}/tasks/${id}/unread`, {
          method: 'POST',
        })
      } catch {
        // best-effort; the next poll restores the true marker
      }
    },
    [tasksRef, setTasks],
  )

  // Write one task through the mutation fence: apply `patch` optimistically,
  // send the request, then settle on the task the server returns — or roll back
  // to the server's copy on failure. The fence keeps a poll issued before the
  // write from painting the old state back over the new. With no `action` the
  // patch itself is PATCHed to the task; with one, it is a bodiless POST to
  // that sub-route and the patch is only the local prediction of its effect
  // (possibly empty, when the result can't be predicted).
  const writeTask = useCallback(
    async (task: TaskWithProject, patch: TaskPatch, action?: string) => {
      const proj = task.projectSlug
      setError(null)
      const mutation = beginTaskMutation(task, patch)
      try {
        const r = await fetch(
          `/api/${proj}/tasks/${task.id}${action ? `/${action}` : ''}`,
          action
            ? { method: 'POST', headers: uiHeaders() }
            : {
                method: 'PATCH',
                headers: uiHeaders(),
                body: JSON.stringify(patch),
              },
        )
        const body = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(body.error ?? r.statusText)
        finishTaskMutation(mutation, {
          ...(body as TaskWithProject),
          projectSlug: proj,
        })
      } catch (err) {
        finishTaskMutation(mutation)
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [setError, beginTaskMutation, finishTaskMutation],
  )

  const setStatus = useCallback(
    (task: TaskWithProject, status: string) => writeTask(task, { status }),
    [writeTask],
  )

  // Archive (or restore) a task by moving it between the project's tasks/ and
  // archived/ dirs. The list shows only active tasks or only archived ones, so
  // either action moves the row out of the current view: optimistically drop it
  // from the list. A reload reconciles.
  const archiveTask = useCallback(
    async (task: TaskWithProject, archived: boolean) => {
      const id = task.id
      const proj = task.projectSlug
      const key = taskKeyOf(task)
      setError(null)
      setTasks((prev) => prev.filter((t) => taskKeyOf(t) !== key))
      try {
        const r = await fetch(`/api/${proj}/tasks/${id}/archive`, {
          method: 'POST',
          headers: uiHeaders(),
          body: JSON.stringify({ archived }),
        })
        if (!r.ok) {
          const body = await r.json()
          throw new Error(body.error ?? r.statusText)
        }
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [setError, setTasks, refresh],
  )

  // Archive a whole section's tasks at once (the section header's kebab). The
  // caller resolves the section to its target tasks — a status, or a single
  // status+date bucket. Drops them all optimistically, fires the per-task
  // archive calls in parallel, then reloads to reconcile — including any that
  // failed, which the reload brings back. Only offered for non-riding sections
  // (a riding task has a live run the server won't archive), so every target
  // is archivable.
  const archiveSection = useCallback(
    async (targets: TaskWithProject[]) => {
      if (targets.length === 0) return
      const keys = new Set(targets.map(taskKeyOf))
      setError(null)
      setTasks((prev) => prev.filter((t) => !keys.has(taskKeyOf(t))))
      try {
        await Promise.all(
          targets.map(async (t) => {
            const r = await fetch(`/api/${t.projectSlug}/tasks/${t.id}/archive`, {
              method: 'POST',
              headers: uiHeaders(),
              body: JSON.stringify({ archived: true }),
            })
            if (!r.ok) {
              const body = await r.json()
              throw new Error(body.error ?? r.statusText)
            }
          }),
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
      await refresh()
    },
    [setError, setTasks, refresh],
  )

  // Launch a scheduled task now, ahead of its time (the header's "launch"
  // button). The server clears the schedule, records the launch, and starts the
  // agent. Optimistically drop the schedule and flip to riding so the launch
  // button gives way to the paced one at once.
  const launchNow = useCallback(
    (task: TaskWithProject) =>
      writeTask(task, { status: 'riding', scheduledFor: undefined }, 'launch'),
    [writeTask],
  )

  // Grant a permission rule: "task" scope persists the rule on the task (used on
  // future turns), "project" scope writes it to the project's settings.local.json.
  // Refresh so a task-scoped grant shows up. Returns whether the grant landed, so
  // a caller (the blocked-summary rows) can mark the row granted only on success.
  // The rule may have been hand-edited before granting.
  const allowTool = useCallback(
    async (rule: string, scope: 'task' | 'project'): Promise<boolean> => {
      const current = currentRef.current
      if (!current) return false
      const id = current.id
      const proj = current.projectSlug
      setError(null)
      try {
        const r = await fetch(`/api/${proj}/tasks/${id}/allow`, {
          method: 'POST',
          headers: uiHeaders(),
          body: JSON.stringify({ rule, scope }),
        })
        const body = await r.json()
        if (!r.ok) throw new Error(body.error ?? r.statusText)
        // A codex task-scope grant succeeds but comes back with a parity warning;
        // surface it without treating the grant as failed.
        if (typeof body.warning === 'string') setError(body.warning)
        if (scope === 'task') await refresh()
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return false
      }
    },
    [currentRef, setError, refresh],
  )

  const setAllowEdits = useCallback(
    async (checked: boolean) => {
      const current = currentRef.current
      if (!current) return
      await writeTask(current, { allowEdits: checked })
    },
    [currentRef, writeTask],
  )

  // Rename the open task; the edit-mode state stays with the caller. A blank
  // or unchanged draft is a no-op.
  const saveTitle = useCallback(
    async (draft: string) => {
      const current = currentRef.current
      if (!current) return
      const next = draft.trim()
      if (!next || next === current.title) return
      await writeTask(current, { title: next })
    },
    [currentRef, writeTask],
  )

  // Ask haiku (server-side) to name the task from its conversation. The new
  // title can't be predicted, so the patch is empty: the fence only keeps a poll
  // issued before the answer from reverting the title it brings.
  const generateTitle = useCallback(async () => {
    const current = currentRef.current
    if (!current || retitling === taskKeyOf(current)) return
    const key = taskKeyOf(current)
    setRetitling(key)
    try {
      await writeTask(current, {}, 'retitle')
    } finally {
      setRetitling((prev) => (prev === key ? null : prev))
    }
  }, [currentRef, retitling, writeTask])

  // Answer an ask (a choice option, confirm yes/no, or free text). The server
  // stamps the answer and un-wedges — or schedules the delivery for a future
  // option `at` — then re-drives the session; here we just post and refresh.
  // Per-task in-flight disabling mirrors the send path (sendingBy).
  const answerAsk = useCallback(
    async (askId: string, body: { optionId?: string; text?: string }) => {
      const current = currentRef.current
      if (!current) return
      const id = current.id
      const proj = current.projectSlug
      const key = taskKeyOf(current)
      if (answeringBy[key]) return
      setAnsweringBy((prev) => ({ ...prev, [key]: true }))
      setError(null)
      try {
        const r = await fetch(`/api/${proj}/tasks/${id}/asks/${askId}/answer`, {
          method: 'POST',
          headers: uiHeaders(),
          body: JSON.stringify(body),
        })
        const resBody = await r.json()
        if (!r.ok) throw new Error(resBody.error ?? r.statusText)
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setAnsweringBy((prev) => ({ ...prev, [key]: false }))
      }
    },
    [currentRef, answeringBy, setError, refresh],
  )

  // Fire one of the kebab menu's actions (see availableTaskActions) on a task —
  // the one entry point the list rows and the detail header share, so neither
  // they nor App need to know what each action name does.
  const runTaskAction = useCallback(
    (task: TaskWithProject, action: TaskAction) => {
      if (action === 'launch') void launchNow(task)
      else if (action === 'wedge') void setStatus(task, 'wedged')
      else if (action === 'land') void setStatus(task, 'landed')
      else if (action === 'unwedge' || action === 'unland')
        void setStatus(task, 'paced')
      else if (action === 'copyId')
        void navigator.clipboard.writeText(task.id).catch(() => {})
      else if (action === 'markUnread') void markUnread(taskKeyOf(task))
      else if (action === 'archive') void archiveTask(task, true)
      else if (action === 'restore') void archiveTask(task, false)
    },
    [launchNow, setStatus, markUnread, archiveTask],
  )

  return {
    markSeen,
    runTaskAction,
    archiveSection,
    allowTool,
    setAllowEdits,
    saveTitle,
    generateTitle,
    retitling,
    answerAsk,
    answeringBy,
  }
}
