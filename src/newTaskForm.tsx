import { memo, useState } from 'react'
import { uiHeaders, uploadAttachments } from './api'
import { ComposerPanel } from './composerPanel'
import { agentDisplayName } from '../shared/agentDisplay'
import { useSessionState } from './hooks'
import type { FlowMeta, Task, TaskWithProject } from './types'

// The sidebar's new-task composer: the draft message and its attachments, the
// agent picker, and task creation.
export const NewTaskForm = memo(function NewTaskForm({
  targetSlug,
  flows,
  height,
  setError,
  admit,
  onCreated,
}: {
  // The project a new task is created in: the one the navbar has open.
  targetSlug: string
  flows: FlowMeta[]
  height: number
  setError: (message: string | null) => void
  // Puts the created task into the displayed list from the POST's own answer,
  // so the form never waits on a whole-list refetch to show it.
  admit: (task: TaskWithProject) => void
  onCreated: (id: string, slug: string) => void
}) {
  // The draft message persists across reloads so a half-composed task isn't
  // lost to a hot reload or refresh. Session-scoped: two tabs composing
  // different tasks keep independent drafts (localStorage would let them
  // clobber each other).
  const [message, setMessage] = useSessionState('lander:draft:newTask', '')
  const [savedFlow, setFlow] = useSessionState<string>('lander:draft:newFlow', '')
  const driverFlows = flows.filter((f) => f.driver)
  const flow = driverFlows.some((f) => f.name === savedFlow)
    ? savedFlow
    : (driverFlows[0]?.name ?? '')
  // Files attached to the message, held as File objects (not session-persisted
  // — File isn't serializable) and uploaded to the durable store on submit.
  const [newFiles, setNewFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)

  async function createTask() {
    if (!message.trim() || submitting || !targetSlug || !flow) return
    setSubmitting(true)
    setError(null)
    try {
      const attachments = await uploadAttachments(targetSlug, newFiles)
      const r = await fetch(`/api/${targetSlug}/tasks`, {
        method: 'POST',
        headers: uiHeaders(),
        body: JSON.stringify({
          message,
          flow,
          ...(attachments.length ? { attachments } : {}),
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      const created = body as Task
      admit({ ...created, projectSlug: targetSlug })
      onCreated(created.id, targetSlug)
      setMessage('')
      setNewFiles([])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ComposerPanel
      as="form"
      className="new-task"
      height={height}
      value={message}
      onChange={setMessage}
      onSubmit={() => void createTask()}
      placeholder="Message"
      rows={4}
      busy={submitting}
      files={newFiles}
      onAddFiles={(picked) => setNewFiles((prev) => [...prev, ...picked])}
      onKeepFiles={(count) => setNewFiles((prev) => prev.slice(0, count))}
      head={
        <div className="new-task-head">
          <h2>New task</h2>
          <select
            className="new-task-agent"
            value={flow}
            disabled={!driverFlows.length}
            // No cast: the option values come from the registry, so there is no
            // closed union to assert the string into.
            onChange={(e) => setFlow(e.target.value)}
          >
            {driverFlows.length ? (
              driverFlows.map((f) => (
                <option key={f.name} value={f.name} title={f.description}>
                  {agentDisplayName(f.name)}
                </option>
              ))
            ) : (
              <option value="">Waiting for daemon…</option>
            )}
          </select>
        </div>
      }
      actions={
        <button
          type="submit"
          className="launch-btn"
          disabled={submitting || !message.trim() || !flow}
        >
          {submitting ? 'Launching…' : 'Launch'}
        </button>
      }
    />
  )
})
