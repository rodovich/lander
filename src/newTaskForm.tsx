import { memo, useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { loadFlows, uiHeaders, uploadAttachments } from './api'
import { AttachButton } from './attachments'
import { clipboardImageFiles } from './fileDrop'
import { agentDisplayName } from './agentDisplay'
import { lastPathComponent } from './format'
import { useFileDrop, useSessionState } from './hooks'
import type { FlowMeta, Project, Task } from './types'

// The sidebar's new-task composer: the draft message and its attachments, the
// agent/project pickers, and task creation. The agent and project picks are
// owned by App — the telemetry panel reads the agent, and the project menu
// writes the project on a single-project pick — but the rest of the draft
// state lives here, used nowhere else.
export const NewTaskForm = memo(function NewTaskForm({
  projects,
  shown,
  currentProjectSlug,
  flow,
  setFlow,
  newProject,
  setNewProject,
  height,
  setError,
  refresh,
  onCreated,
}: {
  projects: Project[]
  shown: string[]
  // The open task's project, the fallback target when several are shown.
  currentProjectSlug: string | undefined
  // The picked driver flow's name. A plain string, not a closed union: the set
  // is whatever the daemon announced.
  flow: string
  setFlow: Dispatch<SetStateAction<string>>
  // Explicit project override for the form; empty means "follow the default"
  // (targetSlug below).
  newProject: string
  setNewProject: Dispatch<SetStateAction<string>>
  height: number
  setError: (message: string | null) => void
  refresh: () => Promise<void>
  onCreated: (id: string, slug: string) => void
}) {
  // The draft message persists across reloads so a half-composed task isn't
  // lost to a hot reload or refresh. Session-scoped: two tabs composing
  // different tasks keep independent drafts (localStorage would let them
  // clobber each other).
  const [message, setMessage] = useSessionState('lander:draft:newTask', '')
  // Files attached to the message, held as File objects (not session-persisted
  // — File isn't serializable) and uploaded to the durable store on submit.
  // The paperclip <AttachButton> owns its own hidden file input.
  const [newFiles, setNewFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)

  // The whole panel is one drop target, including its textarea, paperclip, and
  // surrounding action area.
  const newMessageDrop = useFileDrop<HTMLFormElement>(
    (picked) => setNewFiles((prev) => [...prev, ...picked]),
    submitting,
  )

  // The project a new task is created in: an explicit pick from the form's
  // dropdown if made, else the single shown project, else the project of the
  // task currently open, else the first project.
  const defaultTargetSlug =
    shown.length === 1
      ? shown[0]
      : currentProjectSlug ?? projects[0]?.slug ?? ''
  const targetSlug =
    newProject && projects.some((p) => p.slug === newProject)
      ? newProject
      : defaultTargetSlug

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
      await refresh()
      onCreated(created.id, targetSlug)
      setMessage('')
      setNewFiles([])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    void createTask()
  }

  function onMessageKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Plain Enter creates the task; Shift+Enter / Option(Alt)+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      void createTask()
    }
  }

  return (
    <form
      className={`new-task${newMessageDrop.active ? ' file-drop-active' : ''}`}
      onSubmit={onSubmit}
      style={{ height }}
      {...newMessageDrop.handlers}
    >
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
        {projects.length > 1 && (
          <select
            className="new-task-project"
            value={targetSlug}
            onChange={(e) => setNewProject(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {lastPathComponent(p.path)}
              </option>
            ))}
          </select>
        )}
      </div>
      <textarea
        placeholder="Message"
        rows={4}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={onMessageKeyDown}
        onPaste={(e) => {
          if (submitting) return
          const images = clipboardImageFiles(e.clipboardData)
          if (images.length === 0) return
          e.preventDefault()
          setNewFiles((prev) => [...prev, ...images])
        }}
      />
      <div className="composer-actions">
        <AttachButton
          files={newFiles}
          onAdd={(picked) => setNewFiles((prev) => [...prev, ...picked])}
          onClear={() => setNewFiles([])}
          disabled={submitting}
        />
        <button
          type="submit"
          className="launch-btn"
          disabled={submitting || !message.trim()}
        >
          {submitting ? 'Launching…' : 'Launch'}
        </button>
      </div>
    </form>
  )
})
