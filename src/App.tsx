import { useEffect, useRef, useState } from 'react'
import { Markdown } from './markdown'

type Message = {
  role: 'user' | 'assistant'
  text: string
  createdAt: string
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

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

// While waiting for claude to respond to a user message, show "riding".
// "landed" is terminal, so it always wins over the riding override.
function displayStatus(task: Task): string {
  if (task.status === 'landed') return 'landed'
  const last = task.messages[task.messages.length - 1]
  return last?.role === 'user' ? 'riding' : task.status
}

export function App() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [newAllowEdits, setNewAllowEdits] = useState(false)
  const [newAllowCommits, setNewAllowCommits] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)

  async function loadTasks(): Promise<Task[]> {
    const r = await fetch('/api/tasks')
    const body = await r.json()
    if (!r.ok) throw new Error(body.error ?? r.statusText)
    return body as Task[]
  }

  useEffect(() => {
    fetch('/api/project')
      .then((r) => r.json())
      .then((b) => setProjectPath(b.path))
      .catch(() => {})
  }, [])

  useEffect(() => {
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
  }, [])

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
      const r = await fetch('/api/tasks', {
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

  // Scroll to the latest message when switching tasks or when a new message
  // arrives on the open task.
  const messagesRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [selected, current?.messages.length])

  // Show non-landed tasks above landed ones, preserving order within each group.
  const orderedTasks = [
    ...tasks.filter((t) => t.status !== 'landed'),
    ...tasks.filter((t) => t.status === 'landed'),
  ]

  async function sendReply() {
    if (!current || !reply.trim() || sending) return
    setSending(true)
    setError(null)
    try {
      const r = await fetch(`/api/tasks/${current.session}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: reply }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      setReply('')
      setTasks(await loadTasks())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
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
      const r = await fetch(`/api/tasks/${id}`, {
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
      const r = await fetch(`/api/tasks/${id}`, {
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
      const r = await fetch(`/api/tasks/${id}`, {
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
        {projectPath && <div className="project-path">{projectPath}</div>}
        <ul className="task-list">
          {tasks.length === 0 && (
            <li className="empty">No tasks yet</li>
          )}
          {orderedTasks.map((task) => (
            <li
              key={task.session}
              className={
                'task-item' +
                (task.session === selected ? ' selected' : '') +
                (displayStatus(task) === 'landed' ? ' landed' : '')
              }
              onClick={() => setSelected(task.session)}
            >
              <div className="task-title">{task.title}</div>
              <div
                className={
                  'task-status' +
                  (displayStatus(task) === 'riding' ? ' riding' : '') +
                  (displayStatus(task) === 'landed' ? ' landed' : '')
                }
              >
                {displayStatus(task)}
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
                <h1>{current.title}</h1>
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
                    (displayStatus(current) === 'riding' ? ' riding' : '') +
                    (displayStatus(current) === 'landed' ? ' landed' : '')
                  }
                >
                  {displayStatus(current)}
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
                  <div className="message-text">
                    <Markdown text={m.text} />
                  </div>
                </div>
              ))}
              {current.messages[current.messages.length - 1]?.role ===
                'user' && <div className="message-pending">claude is working…</div>}
            </div>
            <textarea
              className="composer"
              placeholder="Reply…"
              rows={3}
              value={reply}
              disabled={sending}
              onChange={(e) => setReply(e.target.value)}
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
