import { memo, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { loadFlows, uiHeaders, uploadAttachments } from './api'
import { ComposerPanel } from './composerPanel'
import { agentDisplayName } from './agentDisplay'
import { useSessionState } from './hooks'
import type { FlowMeta, Task, TaskWithProject } from './types'

// The sidebar's new-task composer: the draft message and its attachments, the
// agent picker, and task creation. The agent pick is owned by App — the
// telemetry panel reads it — but the rest of the draft state lives here, used
// nowhere else.
export const NewTaskForm = memo(function NewTaskForm({
  targetSlug,
  flow,
  setFlow,
  height,
  setError,
  admit,
  onCreated,
}: {
  // The project a new task is created in: the one the navbar has open.
  targetSlug: string
  // The picked driver flow's name. A plain string, not a closed union: the set
  // is whatever the daemon announced.
  flow: string
  setFlow: Dispatch<SetStateAction<string>>
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
  // Files attached to the message, held as File objects (not session-persisted
  // — File isn't serializable) and uploaded to the durable store on submit.
  const [newFiles, setNewFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)

  // The flows this project can launch, refetched when the target project
  // changes (step 5 adds project-scoped flows, so the set is per-project even
  // though every flow is bundled today). Seeded with the legacy pair so the
  // picker is never empty — on first paint, or if the fetch fails.
  const [flows, setFlows] = useState<FlowMeta[]>([])
  useEffect(() => {
    if (!targetSlug) return
    let stale = false
    void loadFlows(targetSlug).then((f) => {
      if (!stale && f.length) setFlows(f)
    })
    return () => {
      stale = true
    }
  }, [targetSlug])
  const flowOptions: { name: string; description?: string }[] = flows.length
    ? flows
    : [{ name: 'claude' }, { name: 'codex' }]

  async function createTask() {
    if (!message.trim() || submitting || !targetSlug) return
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
          // `agent` rides along for the legacy flows only. Vite HMR and the
          // server's tsx watch reload independently, so there is a sub-second
          // window where a new client can post to a server that predates
          // `flow` and would otherwise fall back to the env default. Free to
          // close, and meaningless for a non-legacy flow (which such a server
          // couldn't run anyway).
          ...(flow === 'claude' || flow === 'codex' ? { agent: flow } : {}),
          // Human-launched tasks always get edit access; git and other Bash
          // are governed by the project's .claude permissions (Claude) or the
          // workspace-scoped edit profile (Codex). A read-only task is only ever
          // produced by a spawner declining to forward edits, and the human
          // can grant edits from the task header.
          allowEdits: true,
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
      onClearFiles={() => setNewFiles([])}
      head={
        <div className="new-task-head">
          <h2>New task</h2>
          <select
            className="new-task-agent"
            value={flow}
            // No cast: the option values come from the registry, so there is no
            // closed union to assert the string into.
            onChange={(e) => setFlow(e.target.value)}
          >
            {flowOptions.map((f) => (
              <option key={f.name} value={f.name} title={f.description}>
                {agentDisplayName(f.name)}
              </option>
            ))}
          </select>
        </div>
      }
      actions={
        <button
          type="submit"
          className="launch-btn"
          disabled={submitting || !message.trim()}
        >
          {submitting ? 'Launching…' : 'Launch'}
        </button>
      }
    />
  )
})
