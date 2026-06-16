import { useEffect, useRef, useState } from 'react'
import { Markdown } from './markdown'

type Step = {
  kind: 'text' | 'tool_use' | 'tool_result'
  text?: string
  tool?: string
  input?: string
  createdAt: string
}

type Message = {
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  steps?: Step[]
  pending?: boolean
}

type Task = {
  session: string
  title: string
  status: string
  createdAt: string
  updatedAt?: string
  allowEdits: boolean
  allowCommits: boolean
  messages: Message[]
}

type Project = {
  path: string
  slug: string
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

// The project slug is the first path segment, e.g. "/users-me-code-app/" ->
// "users-me-code-app". Empty on "/" until we redirect to the first project.
function slugFromPath(): string {
  return window.location.pathname.split('/').filter(Boolean)[0] ?? ''
}

// One entry in a streamed assistant turn: prose as markdown, a tool call as a
// compact chip, or a dimmed peek at a tool result.
function Step({ step }: { step: Step }) {
  if (step.kind === 'tool_use') {
    return (
      <div className="step-tool">
        <span className="step-tool-name">{step.tool}</span>
        {step.input && <span className="step-tool-input">{step.input}</span>}
      </div>
    )
  }
  if (step.kind === 'tool_result') {
    return step.text ? <div className="step-result">{step.text}</div> : null
  }
  return (
    <div className="message-text">
      <Markdown text={step.text ?? ''} />
    </div>
  )
}

export function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [slug, setSlug] = useState<string>(slugFromPath)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [newAllowEdits, setNewAllowEdits] = useState(false)
  const [newAllowCommits, setNewAllowCommits] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Each task keeps its own draft and in-flight state, keyed by session, so you
  // can start a reply in one task, switch away, and come back to finish it.
  const [replies, setReplies] = useState<Record<string, string>>({})
  const [sendingBy, setSendingBy] = useState<Record<string, boolean>>({})

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [retitling, setRetitling] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)

  async function loadTasks(): Promise<Task[]> {
    const r = await fetch(`/api/${slug}/tasks`)
    const body = await r.json()
    if (!r.ok) throw new Error(body.error ?? r.statusText)
    return body as Task[]
  }

  // Load the project list once, then make sure the URL names a real project:
  // visiting "/" (or an unknown slug) redirects to the first project.
  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((list: Project[]) => {
        setProjects(list)
        const current = slugFromPath()
        if (list.some((p) => p.slug === current)) {
          setSlug(current)
        } else if (list.length > 0) {
          window.history.replaceState(null, '', `/${list[0].slug}/`)
          setSlug(list[0].slug)
        }
      })
      .catch(() => {})
  }, [])

  // Keep the slug in sync when the user navigates with the browser back/forward.
  useEffect(() => {
    const onPop = () => setSlug(slugFromPath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Cmd/Ctrl+Shift+F focuses the task search field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        const el = searchInputRef.current
        el?.focus()
        el?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    if (!slug) return
    let cancelled = false
    const refresh = () =>
      loadTasks()
        .then((t) => {
          if (!cancelled) setTasks(t)
        })
        .catch((e) => {
          if (!cancelled) setError(e.message ?? String(e))
        })
    refresh()
    // Poll so claude replies appear once the server appends them.
    const timer = setInterval(refresh, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  function selectProject(next: string) {
    if (next === slug) return
    window.history.pushState(null, '', `/${next}/`)
    setSlug(next)
    setSelected(null)
    setTasks([])
    setError(null)
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

  async function createTask() {
    if ((!title.trim() && !message.trim()) || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const r = await fetch(`/api/${slug}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          message,
          allowEdits: newAllowEdits,
          allowCommits: newAllowCommits,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      const created = body as Task
      setTasks(await loadTasks())
      setSelected(created.session)
      setTitle('')
      setMessage('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const current = tasks.find((t) => t.session === selected) ?? null

  // Leave edit mode when switching tasks so a draft never bleeds across them.
  useEffect(() => {
    setEditingTitle(false)
  }, [selected])

  // Focus and select the title when entering edit mode.
  useEffect(() => {
    if (editingTitle) {
      const el = titleInputRef.current
      el?.focus()
      el?.select()
    }
  }, [editingTitle])

  function startTitleEdit() {
    if (!current) return
    setTitleDraft(current.title)
    setEditingTitle(true)
  }

  async function saveTitle() {
    if (!current) return
    const id = current.session
    const next = titleDraft.trim()
    setEditingTitle(false)
    if (!next || next === current.title) return
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.session === id ? { ...t, title: next } : t)),
    )
    try {
      const r = await fetch(`/api/${slug}/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: next }),
      })
      if (!r.ok) {
        const body = await r.json()
        throw new Error(body.error ?? r.statusText)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Ask haiku (server-side) to name the task from its conversation.
  async function generateTitle() {
    if (!current || retitling) return
    const id = current.session
    setRetitling(true)
    setError(null)
    try {
      const r = await fetch(`/api/${slug}/tasks/${id}/retitle`, {
        method: 'POST',
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      const updated = body as Task
      setTasks((prev) =>
        prev.map((t) => (t.session === id ? { ...t, title: updated.title } : t)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRetitling(false)
    }
  }

  function onTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveTitle()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditingTitle(false)
    }
  }

  // Scroll to the latest message when switching tasks or when a new message
  // arrives on the open task.
  const messagesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [selected, current?.messages.length])

  // Filter by title (case-insensitive) before grouping.
  const query = filter.trim().toLowerCase()
  const matchedTasks = query
    ? tasks.filter((t) => t.title.toLowerCase().includes(query))
    : tasks

  // Show non-landed tasks above landed ones, preserving order within each group.
  const orderedTasks = [
    ...matchedTasks.filter((t) => t.status !== 'landed'),
    ...matchedTasks.filter((t) => t.status === 'landed'),
  ]

  async function sendReply() {
    if (!current) return
    const id = current.session
    const draft = replies[id] ?? ''
    if (!draft.trim() || sendingBy[id]) return
    setSendingBy((prev) => ({ ...prev, [id]: true }))
    setError(null)
    try {
      const r = await fetch(`/api/${slug}/tasks/${id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: draft }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      setReplies((prev) => ({ ...prev, [id]: '' }))
      setTasks(await loadTasks())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSendingBy((prev) => ({ ...prev, [id]: false }))
    }
  }

  async function setAllowEdits(checked: boolean) {
    if (!current) return
    const id = current.session
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.session === id ? { ...t, allowEdits: checked } : t)),
    )
    try {
      const r = await fetch(`/api/${slug}/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowEdits: checked }),
      })
      if (!r.ok) {
        const body = await r.json()
        throw new Error(body.error ?? r.statusText)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function setAllowCommits(checked: boolean) {
    if (!current) return
    const id = current.session
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.session === id ? { ...t, allowCommits: checked } : t)),
    )
    try {
      const r = await fetch(`/api/${slug}/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ allowCommits: checked }),
      })
      if (!r.ok) {
        const body = await r.json()
        throw new Error(body.error ?? r.statusText)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function setStatus(status: string) {
    if (!current) return
    const id = current.session
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.session === id ? { ...t, status } : t)),
    )
    try {
      const r = await fetch(`/api/${slug}/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!r.ok) {
        const body = await r.json()
        throw new Error(body.error ?? r.statusText)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function onReplyKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Plain Enter sends; Shift+Enter / Option(Alt)+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      void sendReply()
    }
  }

  return (
    <div className="layout">
      <div className="sidebar">
        {projects.length > 0 && (
          <select
            className="project-select"
            value={slug}
            onChange={(e) => selectProject(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.path}
              </option>
            ))}
          </select>
        )}
        <input
          ref={searchInputRef}
          type="search"
          className="task-search"
          placeholder="Search tasks (⌘⇧F)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <ul className="task-list">
          {tasks.length === 0 && (
            <li className="empty">No tasks yet</li>
          )}
          {tasks.length > 0 && orderedTasks.length === 0 && (
            <li className="empty">No matching tasks</li>
          )}
          {orderedTasks.map((task) => (
            <li
              key={task.session}
              className={
                'task-item' +
                (task.session === selected ? ' selected' : '') +
                (task.status === 'landed' ? ' landed' : '')
              }
              onClick={() => setSelected(task.session)}
            >
              <div className="task-title">{task.title}</div>
              <div
                className={
                  'task-status' +
                  (task.status === 'riding' ? ' riding' : '') +
                  (task.status === 'landed' ? ' landed' : '')
                }
              >
                {task.status}
              </div>
              <div className="task-time">
                {formatTimestamp(task.updatedAt ?? task.createdAt)}
              </div>
            </li>
          ))}
        </ul>

        <form className="new-task" onSubmit={onSubmit}>
          <h2>New task</h2>
          <input
            type="text"
            placeholder="Title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <textarea
            placeholder="Message"
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={onMessageKeyDown}
          />
          <div className="allow-row">
            <label className="allow-edits">
              <input
                type="checkbox"
                checked={newAllowEdits}
                onChange={(e) => setNewAllowEdits(e.target.checked)}
              />
              allow edits
            </label>
            <label className="allow-edits">
              <input
                type="checkbox"
                checked={newAllowCommits}
                onChange={(e) => setNewAllowCommits(e.target.checked)}
              />
              allow commits
            </label>
          </div>
          <button
            type="submit"
            disabled={submitting || (!title.trim() && !message.trim())}
          >
            {submitting ? 'Creating…' : 'Create task'}
          </button>
        </form>
      </div>

      <div className="detail">
        {error && <div className="error">{error}</div>}
        {current ? (
          <>
            <div className="detail-header">
              <div className="detail-header-top">
                {editingTitle ? (
                  <input
                    ref={titleInputRef}
                    className="title-input"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onKeyDown={onTitleKeyDown}
                    onBlur={() => setEditingTitle(false)}
                  />
                ) : (
                  <div className="title-row">
                    <h1>{current.title}</h1>
                    <button
                      className="edit-title-button"
                      title="Edit title"
                      aria-label="Edit title"
                      onClick={startTitleEdit}
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M11.5 2.5l2 2L6 12l-2.5.5L4 10z" />
                      </svg>
                    </button>
                    <button
                      className="edit-title-button"
                      title="Suggest a title with haiku"
                      aria-label="Suggest a title"
                      disabled={retitling}
                      onClick={() => void generateTitle()}
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M8 1.5l1.4 3.6 3.6 1.4-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4z" />
                        <path d="M13 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
                      </svg>
                    </button>
                  </div>
                )}
                <div className="header-actions">
                  <button
                    className="wedged-button"
                    disabled={current.status === 'wedged'}
                    onClick={() => void setStatus('wedged')}
                  >
                    wedged
                  </button>
                  <button
                    className="landed-button"
                    disabled={current.status === 'landed'}
                    onClick={() => void setStatus('landed')}
                  >
                    landed
                  </button>
                </div>
              </div>
              <div className="detail-meta">
                <span
                  className={
                    'task-status' +
                    (current.status === 'riding' ? ' riding' : '') +
                    (current.status === 'landed' ? ' landed' : '')
                  }
                >
                  {current.status}
                </span>
                <span className="task-time">
                  {formatTimestamp(current.createdAt)}
                </span>
              </div>
            </div>
            <div className="messages" ref={messagesRef}>
              {current.messages.map((m, i) => (
                <div className={`message message-${m.role}`} key={i}>
                  <div className="message-head">
                    <span className="message-role">{m.role}</span>
                    <span className="message-time">
                      {formatTimestamp(m.createdAt)}
                    </span>
                  </div>
                  {/* Streamed assistant turns render their live activity trace;
                      user and legacy messages just render their text. */}
                  {m.steps && m.steps.length > 0 ? (
                    <div className="steps">
                      {m.steps.map((s, j) => (
                        <Step key={j} step={s} />
                      ))}
                    </div>
                  ) : (
                    m.text && (
                      <div className="message-text">
                        <Markdown text={m.text} />
                      </div>
                    )
                  )}
                  {m.pending && (
                    <div className="message-pending">claude is working…</div>
                  )}
                </div>
              ))}
              {current.messages[current.messages.length - 1]?.role ===
                'user' && <div className="message-pending">claude is working…</div>}
            </div>
            <textarea
              className="composer"
              placeholder="Reply…"
              rows={3}
              value={replies[current.session] ?? ''}
              disabled={sendingBy[current.session] ?? false}
              onChange={(e) =>
                setReplies((prev) => ({
                  ...prev,
                  [current.session]: e.target.value,
                }))
              }
              onKeyDown={onReplyKeyDown}
            />
            <div className="allow-row">
              <label className="allow-edits">
                <input
                  type="checkbox"
                  checked={current.allowEdits}
                  onChange={(e) => void setAllowEdits(e.target.checked)}
                />
                allow edits
              </label>
              <label className="allow-edits">
                <input
                  type="checkbox"
                  checked={current.allowCommits}
                  onChange={(e) => void setAllowCommits(e.target.checked)}
                />
                allow commits
              </label>
            </div>
          </>
        ) : (
          <div className="placeholder">Select a task</div>
        )}
      </div>
    </div>
  )
}
