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

// A task tagged with the slug of the project it came from, so the merged
// cross-project list knows which project's API to hit for each task.
type TaskWithProject = Task & { projectSlug: string }

type Project = {
  path: string
  slug: string
}

type UsageWindow = { utilization: number; resetsAt: string | null }
type Usage = { session: UsageWindow | null; weekly: UsageWindow | null }

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

// "/Users/me/code/myapp" -> "myapp"; the leaf is enough to tell projects apart
// in the task list without showing the whole path.
function lastPathComponent(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

// The selected task's project is the first path segment, e.g.
// "/users-me-code-app/task1/" -> "users-me-code-app". Empty on "/".
function slugFromPath(): string {
  return window.location.pathname.split('/').filter(Boolean)[0] ?? ''
}

// The selected task's session is the second path segment, e.g.
// "/users-me-code-app/task1/" -> "task1". Empty when no task is in the URL.
function sessionFromPath(): string {
  return window.location.pathname.split('/').filter(Boolean)[1] ?? ''
}

// A clock time like "3:45 PM" for when a window resets.
function formatResetTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// How a reset moment reads: the clock time if it lands today, otherwise the
// weekday (e.g. "Mon"). Used for the weekly window, which usually resets on a
// later day.
function formatResetWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay
    ? formatResetTime(iso)
    : d.toLocaleDateString([], { weekday: 'short' })
}

// One labeled progress bar: a percentage of a usage window plus when it resets.
function UsageBar({
  label,
  window,
  reset,
}: {
  label: string
  window: UsageWindow
  reset: string
}) {
  const pct = Math.max(0, Math.min(100, Math.round(window.utilization)))
  // Same thresholds as the statusline: green under 70, amber 70-89, red 90+.
  const level = pct >= 90 ? 'high' : pct >= 70 ? 'medium' : ''
  return (
    <div className="usage-window">
      <div className="usage-window-head">
        <span className="usage-label">{label}</span>
        <span className="usage-pct">{pct}%</span>
      </div>
      <div
        className="usage-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={'usage-bar-fill' + (level ? ' ' + level : '')}
          style={{ width: `${pct}%` }}
        />
      </div>
      {reset && <div className="usage-reset">resets {reset}</div>}
    </div>
  )
}

const USAGE_MIN_INTERVAL_MS = 60_000

// Compact Claude subscription usage shown under the new-task form: the current
// 5-hour session window and the 7-day weekly window, each a small progress bar
// with its reset time. Fetched from the server, which proxies the OAuth usage
// endpoint. Refreshed on mount and whenever `refreshSignal` changes (the parent
// bumps it as agent responses complete), but no more than once a minute: a
// request inside that window keeps the cached value and schedules a single
// trailing refresh at the minute mark instead.
function UsageSummary({ refreshSignal }: { refreshSignal: number }) {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [failed, setFailed] = useState(false)

  const cancelledRef = useRef(false)
  const lastFetchRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchNow = () => {
    lastFetchRef.current = Date.now()
    fetch('/api/usage')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((u: Usage) => {
        if (!cancelledRef.current) {
          setUsage(u)
          setFailed(false)
        }
      })
      .catch(() => {
        if (!cancelledRef.current) setFailed(true)
      })
  }

  // Refresh now if it's been at least a minute since the last fetch; otherwise
  // leave the displayed value as-is and arm a single timer to refresh once the
  // minute is up. A timer already in flight absorbs further requests.
  const requestRefresh = () => {
    const elapsed = Date.now() - lastFetchRef.current
    if (elapsed >= USAGE_MIN_INTERVAL_MS) {
      fetchNow()
    } else if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        if (!cancelledRef.current) fetchNow()
      }, USAGE_MIN_INTERVAL_MS - elapsed)
    }
  }

  // Runs on mount (page load) and on every refreshSignal change.
  useEffect(() => {
    requestRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal])

  useEffect(() => {
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  // Stay quiet until we have something to show; a missing token or endpoint
  // error shouldn't clutter the sidebar.
  if (failed || !usage || (!usage.session && !usage.weekly)) return null

  return (
    <div className="usage-summary">
      <div className="usage-windows">
        {usage.session && (
          <UsageBar
            label="Session"
            window={usage.session}
            reset={
              usage.session.resetsAt
                ? formatResetTime(usage.session.resetsAt)
                : ''
            }
          />
        )}
        {usage.weekly && (
          <UsageBar
            label="Weekly"
            window={usage.weekly}
            reset={
              usage.weekly.resetsAt ? formatResetWhen(usage.weekly.resetsAt) : ''
            }
          />
        )}
      </div>
    </div>
  )
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
  const [tasks, setTasks] = useState<TaskWithProject[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  // The project dropdown acts as a filter: `shown` holds the slugs whose tasks
  // are merged into the list. It is always either a single project or every
  // project ("show all"); see showOnly/showAll below.
  const [shown, setShown] = useState<string[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // The user's explicit task pick. The effective selection (`selected`, below)
  // falls back to the first visible task when this one is filtered away.
  const [selectedSession, setSelectedSession] = useState<string | null>(
    () => sessionFromPath() || null,
  )
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const [message, setMessage] = useState('')
  const [newAllowEdits, setNewAllowEdits] = useState(false)
  const [newAllowCommits, setNewAllowCommits] = useState(false)
  // Explicit project override for the new-task form; empty means "follow the
  // default" (targetSlug below).
  const [newProject, setNewProject] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Each task keeps its own draft and in-flight state, keyed by session, so you
  // can start a reply in one task, switch away, and come back to finish it.
  const [replies, setReplies] = useState<Record<string, string>>({})
  const [sendingBy, setSendingBy] = useState<Record<string, boolean>>({})

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [retitling, setRetitling] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)

  const pathBySlug = new Map(projects.map((p) => [p.slug, p.path]))
  const allShown = projects.length > 0 && shown.length === projects.length
  // Tag each task row with its project's leaf only when more than one project's
  // tasks can be intermixed; with a single project shown it's just noise.
  const showProjectLabels = shown.length > 1

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

  // The effective selection: the user's pick if it's still visible, otherwise
  // the first task in the list (e.g. after filtering hides the prior pick).
  const selected =
    selectedSession && tasks.some((t) => t.session === selectedSession)
      ? selectedSession
      : orderedTasks[0]?.session ?? null
  const current = tasks.find((t) => t.session === selected) ?? null

  // A monotonically rising count of finished assistant turns across all tasks.
  // It ticks up each time a pending message lands (the poll flips `pending` to
  // false), which UsageSummary watches as its cue to refresh — agent activity is
  // exactly when usage moves.
  const completedResponses = tasks.reduce(
    (n, t) =>
      n + t.messages.filter((m) => m.role === 'assistant' && !m.pending).length,
    0,
  )

  // Roving-tabindex bookkeeping for the task list: the selected row is the one
  // reachable with Tab, and arrow keys move DOM focus between rows.
  const taskItemRefs = useRef<(HTMLLIElement | null)[]>([])
  const selectedIndex = orderedTasks.findIndex((t) => t.session === selected)
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : 0

  function selectTask(session: string, projectSlug: string) {
    setSelectedSession(session)
    window.history.pushState(null, '', `/${projectSlug}/${session}`)
  }

  function focusTaskAt(index: number) {
    const clamped = Math.max(0, Math.min(orderedTasks.length - 1, index))
    taskItemRefs.current[clamped]?.focus()
  }

  function onTaskKeyDown(
    e: React.KeyboardEvent<HTMLLIElement>,
    index: number,
    task: TaskWithProject,
  ) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusTaskAt(index + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        focusTaskAt(index - 1)
        break
      case 'Home':
        e.preventDefault()
        focusTaskAt(0)
        break
      case 'End':
        e.preventDefault()
        focusTaskAt(orderedTasks.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        selectTask(task.session, task.projectSlug)
        break
    }
  }

  // Clicking a project shows only that project — unless it was already the only
  // one shown, in which case it expands back to all projects.
  function showOnly(slug: string) {
    if (shown.length === 1 && shown[0] === slug) {
      setShown(projects.map((p) => p.slug))
    } else {
      setShown([slug])
    }
    setMenuOpen(false)
  }

  function showAll() {
    setShown(projects.map((p) => p.slug))
    setMenuOpen(false)
  }

  // Fetch and merge tasks across every shown project, tagging each with its
  // project slug and sorting the combined list by recency.
  async function loadShownTasks(slugs: string[]): Promise<TaskWithProject[]> {
    const lists = await Promise.all(
      slugs.map(async (slug) => {
        const r = await fetch(`/api/${slug}/tasks`)
        const body = await r.json()
        if (!r.ok) throw new Error(body.error ?? r.statusText)
        return (body as Task[]).map((t) => ({ ...t, projectSlug: slug }))
      }),
    )
    const merged = lists.flat()
    merged.sort((a, b) =>
      (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
    )
    return merged
  }

  // Load the project list once and show all projects by default. A task named
  // in the URL is seeded as the selection so a shared/reloaded link opens on it.
  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((list: Project[]) => {
        setProjects(list)
        setShown(list.map((p) => p.slug))
      })
      .catch(() => {})
  }, [])

  // Keep the selection in sync when navigating with the browser back/forward
  // buttons.
  useEffect(() => {
    const onPop = () => setSelectedSession(sessionFromPath() || null)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Mirror the effective selection into the URL as /<project>/<session>. Held
  // off until tasks have loaded so a deep-linked session isn't clobbered before
  // its project's tasks arrive. replaceState (not push) corrects the URL in
  // place without adding spurious history entries.
  const hasLoadedRef = useRef(false)
  useEffect(() => {
    if (!hasLoadedRef.current) return
    const cur = tasks.find((t) => t.session === selected)
    const desired = cur ? `/${cur.projectSlug}/${cur.session}` : '/'
    if (window.location.pathname !== desired) {
      window.history.replaceState(null, '', desired)
    }
  }, [selected, tasks])

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

  // Close the project menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const shownKey = shown.join(',')
  useEffect(() => {
    if (shown.length === 0) return
    let cancelled = false
    const refresh = () =>
      loadShownTasks(shown)
        .then((t) => {
          if (!cancelled) {
            setTasks(t)
            hasLoadedRef.current = true
          }
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
  }, [shownKey])

  // The project a new task is created in: an explicit pick from the form's
  // dropdown if made, else the single shown project, else the project of the
  // task currently open, else the first project.
  const defaultTargetSlug =
    shown.length === 1
      ? shown[0]
      : current?.projectSlug ?? projects[0]?.slug ?? ''
  const targetSlug =
    newProject && projects.some((p) => p.slug === newProject)
      ? newProject
      : defaultTargetSlug

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
    if (!message.trim() || submitting || !targetSlug) return
    setSubmitting(true)
    setError(null)
    try {
      const r = await fetch(`/api/${targetSlug}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
          allowEdits: newAllowEdits,
          allowCommits: newAllowCommits,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      const created = body as Task
      setTasks(await loadShownTasks(shown))
      selectTask(created.session, targetSlug)
      setMessage('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

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
    const proj = current.projectSlug
    const next = titleDraft.trim()
    setEditingTitle(false)
    if (!next || next === current.title) return
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.session === id ? { ...t, title: next } : t)),
    )
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}`, {
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
    const proj = current.projectSlug
    setRetitling(true)
    setError(null)
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}/retitle`, {
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

  // Keep the conversation pinned to the latest content. We always jump to the
  // bottom when switching tasks, but when new content streams in we only follow
  // along if the reader was already at the bottom — otherwise scrolling up to
  // read earlier messages would be yanked back down on every poll.
  const messagesRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const prevSelectedRef = useRef<string | null>(null)

  function onMessagesScroll() {
    const el = messagesRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
  }

  // Changes whenever the open task's last (typically streaming) message grows,
  // even when the message count stays the same, so the effect re-pins as an
  // assistant turn fills in.
  const lastMessage = current?.messages[current.messages.length - 1]
  const streamSignal = lastMessage
    ? `${lastMessage.steps?.length ?? 0}:` +
      `${lastMessage.steps?.reduce((n, s) => n + (s.text?.length ?? 0), 0) ?? 0}:` +
      `${lastMessage.text?.length ?? 0}`
    : ''

  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    const switched = prevSelectedRef.current !== selected
    prevSelectedRef.current = selected
    if (switched) atBottomRef.current = true
    if (switched || atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [selected, current?.messages.length, streamSignal])

  async function sendReply() {
    if (!current) return
    const id = current.session
    const proj = current.projectSlug
    const draft = replies[id] ?? ''
    if (!draft.trim() || sendingBy[id]) return
    setSendingBy((prev) => ({ ...prev, [id]: true }))
    setError(null)
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: draft }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      setReplies((prev) => ({ ...prev, [id]: '' }))
      setTasks(await loadShownTasks(shown))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSendingBy((prev) => ({ ...prev, [id]: false }))
    }
  }

  async function setAllowEdits(checked: boolean) {
    if (!current) return
    const id = current.session
    const proj = current.projectSlug
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.session === id ? { ...t, allowEdits: checked } : t)),
    )
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}`, {
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
    const proj = current.projectSlug
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.session === id ? { ...t, allowCommits: checked } : t)),
    )
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}`, {
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
    const proj = current.projectSlug
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.session === id ? { ...t, status } : t)),
    )
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}`, {
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

  // Dropdown summary: "All projects" when every project is shown, otherwise the
  // single shown project's path.
  const filterSummary =
    projects.length === 0
      ? ''
      : allShown && projects.length > 1
        ? 'All projects'
        : shown.length === 1
          ? pathBySlug.get(shown[0]) ?? shown[0]
          : `${shown.length} of ${projects.length}`

  return (
    <div className="layout">
      <div className="sidebar">
        {projects.length > 0 && (
          <div className="project-filter" ref={menuRef}>
            <button
              type="button"
              className="project-select"
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span className="project-select-label">{filterSummary}</span>
              <span className="project-select-caret">▾</span>
            </button>
            {menuOpen && (
              <div className="project-menu" role="listbox">
                {projects.map((p) => (
                  <button
                    key={p.slug}
                    type="button"
                    role="option"
                    aria-selected={shown.includes(p.slug)}
                    className="project-menu-item"
                    onClick={() => showOnly(p.slug)}
                  >
                    <span className="project-menu-check">
                      {shown.includes(p.slug) ? '✓' : ''}
                    </span>
                    <span className="project-menu-path">{p.path}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className="project-menu-item project-menu-all"
                  onClick={showAll}
                >
                  <span className="project-menu-check">
                    {allShown ? '✓' : ''}
                  </span>
                  <span className="project-menu-path">Show all</span>
                </button>
              </div>
            )}
          </div>
        )}
        <input
          ref={searchInputRef}
          type="search"
          className="task-search"
          placeholder="Search tasks (⌘⇧F)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <ul className="task-list" role="listbox" aria-label="Tasks">
          {tasks.length === 0 && (
            <li className="empty" role="presentation">No tasks yet</li>
          )}
          {tasks.length > 0 && orderedTasks.length === 0 && (
            <li className="empty" role="presentation">No matching tasks</li>
          )}
          {orderedTasks.map((task, index) => (
            <li
              key={task.session}
              ref={(el) => {
                taskItemRefs.current[index] = el
              }}
              role="option"
              aria-selected={task.session === selected}
              tabIndex={index === rovingIndex ? 0 : -1}
              className={
                'task-item' +
                (task.session === selected ? ' selected' : '') +
                (task.status === 'landed' ? ' landed' : '')
              }
              onClick={() => selectTask(task.session, task.projectSlug)}
              onKeyDown={(e) => onTaskKeyDown(e, index, task)}
            >
              <div className="task-title">{task.title}</div>
              <div className="task-meta-row">
                <span
                  className={
                    'task-status' +
                    (task.status === 'riding' ? ' riding' : '') +
                    (task.status === 'landed' ? ' landed' : '')
                  }
                >
                  {task.status}
                </span>
                {showProjectLabels && (
                  <span className="task-project">
                    {lastPathComponent(
                      pathBySlug.get(task.projectSlug) ?? task.projectSlug,
                    )}
                  </span>
                )}
              </div>
              <div className="task-time">
                {formatTimestamp(task.updatedAt ?? task.createdAt)}
              </div>
            </li>
          ))}
        </ul>

        <form className="new-task" onSubmit={onSubmit}>
          <div className="new-task-head">
            <h2>New task</h2>
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
            disabled={submitting || !message.trim()}
          >
            {submitting ? 'Creating…' : 'Create task'}
          </button>
        </form>

        <UsageSummary refreshSignal={completedResponses} />
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
                {projects.length > 1 && (
                  <span className="task-project">
                    {lastPathComponent(
                      pathBySlug.get(current.projectSlug) ?? current.projectSlug,
                    )}
                  </span>
                )}
                <span className="task-time">
                  {formatTimestamp(current.createdAt)}
                </span>
              </div>
            </div>
            <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
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
            <div className="composer-bar">
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
            </div>
          </>
        ) : (
          <div className="placeholder">Select a task</div>
        )}
      </div>
    </div>
  )
}
