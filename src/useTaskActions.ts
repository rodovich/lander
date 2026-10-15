import { useCallback, useState } from 'react'
import { uiHeaders } from './api'
import { unreadMarker } from './readMarker'
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
  // scheduled them (the read-marker dwell timer marks a task read 3s later).
  tasksRef: { current: TaskWithProject[] }
  refresh: () => Promise<void>
  beginTaskMutation: (
    task: TaskWithProject,
    patch: TaskPatch,
  ) => TaskMutationHandle
  finishTaskMutation: (
    handle: TaskMutationHandle,
    updated?: TaskWithProject,
  ) => void
  beginTaskRemoval: (task: TaskWithProject) => TaskMutationHandle
  finishTaskRemoval: (handle: TaskMutationHandle, succeeded: boolean) => void
  setError: (message: string | null) => void
}) {
  const {
    currentRef,
    tasksRef,
    refresh,
    beginTaskMutation,
    finishTaskMutation,
    beginTaskRemoval,
    finishTaskRemoval,
    setError,
  } = opts

  // Tasks with an ask answer in flight, keyed by project + task id, mirroring the send
  // path's per-task disabling.
  const [answeringBy, setAnsweringBy] = useState<Record<string, boolean>>({})
  // The task whose title is being regenerated, if any.
  const [retitling, setRetitling] = useState<string | null>(null)

  // Write one task through the mutation fence: apply `patch` optimistically,
  // send the request, then settle on the task the server returns — or roll back
  // to the server's copy on failure. The fence keeps a poll issued before the
  // write from painting the old state back over the new. With no `action` the
  // patch itself is PATCHed to the task; with one, it is a POST to that
  // sub-route carrying `body` (if any), and the patch is only the local
  // prediction of its effect (possibly empty, when the result can't be
  // predicted). A `quiet` write is best-effort view state: it neither clears
  // nor sets the error line, only rolls back.
  const writeTask = useCallback(
    async (
      task: TaskWithProject,
      patch: TaskPatch,
      opts: { action?: string; body?: unknown; quiet?: boolean } = {},
    ) => {
      const { action, quiet } = opts
      const proj = task.projectSlug
      if (!quiet) setError(null)
      const mutation = beginTaskMutation(task, patch)
      try {
        const r = await fetch(
          `/api/${proj}/tasks/${task.id}${action ? `/${action}` : ''}`,
          action
            ? {
                method: 'POST',
                headers: uiHeaders(),
                ...(opts.body !== undefined
                  ? { body: JSON.stringify(opts.body) }
                  : {}),
              }
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
        return true
      } catch (err) {
        finishTaskMutation(mutation)
        if (!quiet) setError(err instanceof Error ? err.message : String(err))
        return false
      }
    },
    [setError, beginTaskMutation, finishTaskMutation],
  )

  // Advance a task's server-side read marker to `at`, the conversation read up
  // through it. Written through the fence so the dot clears at once and a poll
  // issued before the mark can't bring it back. The server stores the marker
  // monotonically, so a stale/older value never moves it back. Reads tasksRef
  // so a delayed (dwell-timer) call sees the freshest data.
  const markSeen = useCallback(
    async (key: string, at: string) => {
      const task = tasksRef.current.find((t) => taskKeyOf(t) === key)
      if (!task) return
      if (!at || (task.readThrough && task.readThrough >= at)) return
      await writeTask(
        task,
        { readThrough: at },
        { action: 'seen', body: { at }, quiet: true },
      )
    },
    [tasksRef, writeTask],
  )

  // Mark a task unread: set its read marker back to the human's last message
  // (see unreadMarker), re-showing its dot at once. The next time the viewer
  // reads the task, markSeen advances the marker forward again.
  const markUnread = useCallback(
    async (key: string) => {
      const task = tasksRef.current.find((t) => taskKeyOf(t) === key)
      if (!task) return
      const at = unreadMarker(task)
      if (at === null) return
      await writeTask(
        task,
        { readThrough: at },
        { action: 'unread', body: { at }, quiet: true },
      )
    },
    [tasksRef, writeTask],
  )

  const setStatus = useCallback(
    (task: TaskWithProject, status: string) => writeTask(task, { status }),
    [writeTask],
  )

  // Archive (or restore) a task by moving it between the project's tasks/ and
  // archived/ dirs. The list shows only active tasks or only archived ones, so
  // either move takes the row out of the current view: drop it through the
  // fence, so a poll issued before the move can't bring it back, and reinstate
  // it if the move fails. Throws the failure for the caller to report.
  const moveTask = useCallback(
    async (task: TaskWithProject, archived: boolean) => {
      const removal = beginTaskRemoval(task)
      try {
        const r = await fetch(
          `/api/${task.projectSlug}/tasks/${task.id}/archive`,
          {
            method: 'POST',
            headers: uiHeaders(),
            body: JSON.stringify({ archived }),
          },
        )
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(body.error ?? r.statusText)
        }
        finishTaskRemoval(removal, true)
      } catch (err) {
        finishTaskRemoval(removal, false)
        throw err
      }
    },
    [beginTaskRemoval, finishTaskRemoval],
  )

  const archiveTask = useCallback(
    async (task: TaskWithProject, archived: boolean) => {
      setError(null)
      try {
        await moveTask(task, archived)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [setError, moveTask],
  )

  // Archive a whole section's tasks at once (the section header's kebab). The
  // caller resolves the section to its target tasks — a status, or a single
  // status+date bucket. Moves them all in parallel, each fenced on its own, so
  // any that fail come back while the rest stay archived. Only offered for
  // non-riding sections (a riding task has a live run the server won't
  // archive), so every target is archivable.
  const archiveSection = useCallback(
    async (targets: TaskWithProject[]) => {
      if (targets.length === 0) return
      setError(null)
      const results = await Promise.allSettled(
        targets.map((t) => moveTask(t, true)),
      )
      const failed = results.find((r) => r.status === 'rejected')
      if (failed) {
        const err = failed.reason
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [setError, moveTask],
  )

  // Launch a scheduled task now, ahead of its time (the header's "launch"
  // button). The server clears the schedule, records the launch, and starts the
  // agent. Optimistically drop the schedule and flip to riding so the launch
  // button gives way to the paced one at once.
  const launchNow = useCallback(
    (task: TaskWithProject) =>
      writeTask(
        task,
        { status: 'riding', scheduledFor: undefined },
        { action: 'launch' },
      ),
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
        if (scope === 'task') await refresh()
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        return false
      }
    },
    [currentRef, setError, refresh],
  )

  const tryAgain = useCallback(async () => {
    const current = currentRef.current
    if (
      !current || current.archived ||
      (current.status !== 'wedged' && current.status !== 'paced')
    ) return false
    return writeTask(
      current,
      { status: 'riding' },
      { action: 'messages', body: { message: 'try again' } },
    )
  }, [currentRef, writeTask])

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
      await writeTask(current, {}, { action: 'retitle' })
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
      // All three settle the task paced; pacing a riding one is what interrupts
      // its turn, which the server does on the status change itself.
      else if (action === 'unwedge' || action === 'unland' || action === 'pace')
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
    tryAgain,
    saveTitle,
    generateTitle,
    retitling,
    answerAsk,
    answeringBy,
  }
}
