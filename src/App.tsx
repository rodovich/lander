import { useEffect, useRef, useState } from 'react'
import { Markdown } from './markdown'

// Request headers that mark a call as coming from the human's browser. The
// server gates permission-granting endpoints (creating a task with edit/commit
// access, toggling those grants, allowing a tool) on this token so a task can't
// hit the same API to escalate itself. dev.mjs hands the value to both Vite
// (here) and the API server. JSON content-type rides along since every caller
// that needs the token also sends a JSON body.
const uiHeaders = (): Record<string, string> => {
  const token = import.meta.env.VITE_LANDER_UI_TOKEN
  return {
    'content-type': 'application/json',
    ...(token ? { 'x-lander-ui-token': token } : {}),
  }
}

type Step = {
  kind: 'text' | 'tool_use' | 'tool_result'
  text?: string
  tool?: string
  input?: string
  // Pairs a tool_use step with its tool_result step.
  toolUseId?: string
  // tool_use: the call as a settings.json permission rule, e.g. `Bash(ls)`.
  rule?: string
  // tool_use, for the file-writing tools (Edit/Write/MultiEdit): the change as
  // before/after hunks, revealed as a diff under the chip's disclosure triangle.
  edits?: { old: string; new: string }[]
  // tool_result: outcome flags (set by the server from the stream).
  isError?: boolean
  blocked?: boolean
  createdAt: string
}

// Whether a tool call was permitted, refused, or has no result yet.
type ToolStatus = 'allowed' | 'blocked' | 'pending'

type Message = {
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  steps?: Step[]
  pending?: boolean
}

// A lifecycle event interleaved with messages in the conversation timeline: the
// task's launch, a rename, or a crossing into/out of the wedged (needs the
// user) or terminal landed state. `title` is the task's name as of the event
// (absent on an untitled launch or on events saved before titles were captured).
type TaskEvent = {
  kind: 'launched' | 'wedged' | 'unwedged' | 'landed' | 'unlanded' | 'renamed'
  title?: string
  createdAt: string
}

type Task = {
  session: string
  title: string
  status: string
  createdAt: string
  updatedAt?: string
  // ISO timestamp of the latest completed update the viewer has caught up to;
  // a task shows the unseen-update dot when its latest update is newer. Advanced
  // server-side (monotonically) via the /seen endpoint. Absent on tasks saved
  // before this field existed, until the server backfills it.
  seenAt?: string
  allowEdits: boolean
  allowCommits: boolean
  messages: Message[]
  events?: TaskEvent[]
  // Follow-ups sent while the agent is busy wait here until a drainer picks
  // them up. They're also appended to `messages` for display; this array holds
  // the trailing user messages, in order, that claude hasn't read yet.
  queued?: string[]
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

// The timestamp of a task's most recent *completed* update: the newest of its
// finished messages and its lifecycle events. The in-flight assistant message
// (still streaming) is skipped, so per-chunk churn doesn't count until the
// message lands — that's what keeps the unseen-update dot from flickering on
// mid-stream. ISO timestamps compare lexicographically, so the string max is a
// chronological max; empty string for a task with nothing complete yet.
function latestUpdateAt(task: Task): string {
  let latest = ''
  for (const m of task.messages) {
    if (m.pending) continue
    if (m.createdAt > latest) latest = m.createdAt
  }
  for (const e of task.events ?? []) {
    if (e.createdAt > latest) latest = e.createdAt
  }
  return latest
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

// The grant popup anchored under a tool chip: shows the call as an editable
// settings.json rule plus its permission status, and — when the call was
// blocked — buttons to allow it for just this task or the whole project. The
// textarea seeds from the rule but the user can edit it before granting.
function ToolPopup({
  step,
  status,
  anchor,
  onAllow,
}: {
  step: Step
  status: ToolStatus
  // Viewport coords of the chip's bottom-left, so the fixed-position popup can
  // anchor under the chip while escaping the scrolling timeline's clipping.
  anchor: { top: number; left: number }
  onAllow: (rule: string, scope: 'task' | 'project') => void
}) {
  // `rule` is computed server-side (see toolRule). Steps saved before that field
  // existed fall back to the bare tool name; they predate blocked/isError too, so
  // they never offer the allow buttons anyway — the textarea is just a view.
  const [rule, setRule] = useState(step.rule ?? step.tool ?? '')
  return (
    <div
      className="tool-popup"
      style={{ top: anchor.top, left: anchor.left }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="tool-popup-head">
        <span className="tool-popup-tool">{step.tool}</span>
        <span className={'tool-popup-status' + (status === 'blocked' ? ' blocked' : '')}>
          {status}
        </span>
      </div>
      <textarea
        className="tool-popup-input"
        rows={3}
        value={rule}
        onChange={(e) => setRule(e.target.value)}
      />
      {status === 'blocked' && (
        <div className="tool-popup-actions">
          <button type="button" onClick={() => onAllow(rule, 'task')}>
            allow in task
          </button>
          <button type="button" onClick={() => onAllow(rule, 'project')}>
            allow in project
          </button>
        </div>
      )}
    </div>
  )
}

// The before/after hunks of a file-writing tool call, rendered as a unified
// diff: the old text as removed (red) lines, the new text as added (green) ones.
// One block per edit (MultiEdit carries several); a Write has empty `old`, so it
// shows up as all additions.
function DiffView({ edits }: { edits: { old: string; new: string }[] }) {
  // Split into lines, dropping a single trailing empty line so a string ending
  // in "\n" doesn't render a spurious blank row. An empty side (e.g. a Write's
  // absent "before") contributes no lines at all.
  const lines = (s: string) => {
    if (s === '') return []
    const parts = s.split('\n')
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
    return parts
  }
  return (
    <div className="step-diff">
      {edits.map((e, k) => (
        <pre className="diff-hunk" key={k}>
          {lines(e.old).map((l, n) => (
            <div className="diff-line del" key={`o${n}`}>
              {'- ' + l}
            </div>
          ))}
          {lines(e.new).map((l, n) => (
            <div className="diff-line add" key={`n${n}`}>
              {'+ ' + l}
            </div>
          ))}
        </pre>
      ))}
    </div>
  )
}

// A tool call in the activity trace: a clickable chip (red when the call was
// blocked) that toggles a grant popup. For the file-writing tools the chip also
// gets a disclosure triangle to its left that reveals the edit's diff (default
// closed); option/shift-clicking it toggles every diff in the message at once.
// The chip + popup share one ref so an outside click — anywhere but here —
// dismisses the popup.
function ToolStep({
  step,
  status,
  open,
  onToggle,
  onClose,
  onAllow,
  diffOpen,
  onToggleDiff,
}: {
  step: Step
  status: ToolStatus
  open: boolean
  onToggle: () => void
  onClose: () => void
  onAllow: (rule: string, scope: 'task' | 'project') => void
  diffOpen: boolean
  // `all` is set when the user option/shift-clicked, asking to toggle every
  // diff in the message rather than just this one.
  onToggleDiff: (all: boolean) => void
}) {
  const hasDiff = !!step.edits && step.edits.length > 0
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // The popup is fixed-positioned (so the scrolling timeline can't clip it), so
  // we anchor it to the chip's live viewport rect and re-measure as the timeline
  // scrolls or the window resizes.
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  useEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect()
      if (r) setAnchor({ top: r.bottom + 6, left: r.left })
    }
    place()
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    // Capture phase so the timeline's own scroll (not just window scroll) repositions.
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, onClose])

  return (
    <div className="step-tool" ref={ref}>
      <div className="step-tool-row">
        {hasDiff && (
          <button
            type="button"
            className="step-diff-toggle"
            aria-expanded={diffOpen}
            aria-label={diffOpen ? 'Hide diff' : 'Show diff'}
            title={
              diffOpen ? 'Hide diff (⌥/⇧ for all)' : 'Show diff (⌥/⇧ for all)'
            }
            onClick={(e) => onToggleDiff(e.altKey || e.shiftKey)}
          >
            <span className={'step-diff-caret' + (diffOpen ? ' open' : '')}>▶</span>
          </button>
        )}
        <button
          ref={buttonRef}
          type="button"
          className={'step-tool-name' + (status === 'blocked' ? ' blocked' : '')}
          aria-expanded={open}
          onClick={onToggle}
        >
          {step.tool}
        </button>
        {step.input && <span className="step-tool-input">{step.input}</span>}
      </div>
      {hasDiff && diffOpen && <DiffView edits={step.edits!} />}
      {open && anchor && (
        <ToolPopup step={step} status={status} anchor={anchor} onAllow={onAllow} />
      )}
    </div>
  )
}

// One entry in a streamed assistant turn: prose as markdown, a tool call as a
// clickable chip, or a dimmed peek at a tool result.
function Step({
  step,
  status,
  open,
  onToggle,
  onClose,
  onAllow,
  diffOpen,
  onToggleDiff,
}: {
  step: Step
  status: ToolStatus
  open: boolean
  onToggle: () => void
  onClose: () => void
  onAllow: (rule: string, scope: 'task' | 'project') => void
  diffOpen: boolean
  onToggleDiff: (all: boolean) => void
}) {
  if (step.kind === 'tool_use') {
    return (
      <ToolStep
        step={step}
        status={status}
        open={open}
        onToggle={onToggle}
        onClose={onClose}
        onAllow={onAllow}
        diffOpen={diffOpen}
        onToggleDiff={onToggleDiff}
      />
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

// How each lifecycle event verb reads in the timeline.
const EVENT_VERB: Record<TaskEvent['kind'], string> = {
  launched: 'launched',
  wedged: 'wedged',
  unwedged: 'un-wedged',
  landed: 'landed',
  unlanded: 'un-landed',
  renamed: 'renamed',
}

// A lifecycle event shown inline in the conversation: the task's name (as of
// that moment) followed by the verb — e.g. "Fix the parser launched". The name
// is italic and the verb is set apart by weight/color (blue for launched like
// the riding status, amber for wedged, green for landed, plain otherwise).
// Presented like the
// working-spinner row (unbubbled, muted) but without the spinner, since the
// event is complete.
function StatusTransition({ event }: { event: TaskEvent }) {
  return (
    <div className="status-transition">
      <span className="status-transition-event">
        {event.title && (
          <span className="status-transition-name">{event.title}</span>
        )}
        <span className={`status-transition-label ${event.kind}`}>
          {EVENT_VERB[event.kind]}
        </span>
      </span>
      <span className="status-transition-time">
        {formatTimestamp(event.createdAt)}
      </span>
    </div>
  )
}

// A clipboard button shown in a message's top-right corner. Briefly flips to a
// checkmark after a successful copy so the click registers.
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied (e.g. insecure context); ignore.
    }
  }
  return (
    <button
      type="button"
      className="message-copy"
      onClick={copy}
      title="Copy message"
      aria-label={copied ? 'Copied' : 'Copy message'}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M20 6 9 17l-5-5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect
            x="9"
            y="9"
            width="11"
            height="11"
            rx="2"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M5 15V5a2 2 0 0 1 2-2h10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
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
  const [newAllowEdits, setNewAllowEdits] = useState(true)
  const [newAllowCommits, setNewAllowCommits] = useState(false)
  // Explicit project override for the new-task form; empty means "follow the
  // default" (targetSlug below).
  const [newProject, setNewProject] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Each task keeps its own draft and in-flight state, keyed by session, so you
  // can start a reply in one task, switch away, and come back to finish it.
  const [replies, setReplies] = useState<Record<string, string>>({})
  const [sendingBy, setSendingBy] = useState<Record<string, boolean>>({})

  // The tool chip whose grant popup is open, keyed "<messageIndex>:<stepIndex>".
  // Only one is open at a time; null means none.
  const [openTool, setOpenTool] = useState<string | null>(null)

  // The set of file-writing tool chips whose diff is revealed, keyed the same
  // "<messageIndex>:<stepIndex>". Diffs start closed and several can be open at
  // once (option/shift-click toggles a whole message's worth).
  const [openDiffs, setOpenDiffs] = useState<Set<string>>(new Set())

  // Toggle one chip's diff, or — when option/shift was held — every diff in its
  // message together, driving them all to this chip's new (opposite) state.
  function toggleDiff(key: string, messageKeys: string[]) {
    setOpenDiffs((prev) => {
      const next = new Set(prev)
      const willOpen = !prev.has(key)
      for (const k of messageKeys) {
        if (willOpen) next.add(k)
        else next.delete(k)
      }
      return next
    })
  }

  // The two ambient conditions (alongside having a task open) that make the
  // viewer "actively viewing" it: the conversation is scrolled to its bottom,
  // and this browser tab is the active, focused one.
  const [atBottom, setAtBottom] = useState(true)
  const [tabActive, setTabActive] = useState(
    () => !document.hidden && document.hasFocus(),
  )

  // Latest tasks readable from timer callbacks that outlive the render that
  // scheduled them (the dwell timer below marks a task seen 3s later).
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  // Track whether this tab is the active one: visible and window-focused.
  useEffect(() => {
    const update = () => setTabActive(!document.hidden && document.hasFocus())
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])

  // Mark a task caught-up: advance its server-side `seenAt` to its latest
  // completed update, which clears its unseen dot. Optimistically advances the
  // local copy so the dot clears at once; the 2s poll reconciles. The server
  // stores the marker monotonically, so a stale/older value never moves it back.
  // Reads tasksRef so a delayed (dwell-timer) call sees the freshest data.
  async function markSeen(session: string) {
    const task = tasksRef.current.find((t) => t.session === session)
    if (!task) return
    const at = latestUpdateAt(task)
    if (!at || (task.seenAt && task.seenAt >= at)) return
    setTasks((prev) =>
      prev.map((t) => (t.session === session ? { ...t, seenAt: at } : t)),
    )
    try {
      await fetch(`/api/${task.projectSlug}/tasks/${session}/seen`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ at }),
      })
    } catch {
      // best-effort; a later dwell or the poll will retry the mark
    }
  }

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

  // Group tasks by status — wedged (needs the user) first, then riding,
  // resting, and landed last — preserving each group's recency order within it
  // (matchedTasks is already sorted by updatedAt, and sort is stable). Unknown
  // statuses sort just ahead of landed.
  const STATUS_RANK: Record<string, number> = {
    wedged: 0,
    riding: 1,
    resting: 2,
    landed: 4,
  }
  const orderedTasks = [...matchedTasks].sort(
    (a, b) => (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3),
  )

  // The effective selection: the user's pick if it's still visible, otherwise
  // the first task in the list (e.g. after filtering hides the prior pick).
  const selected =
    selectedSession && tasks.some((t) => t.session === selectedSession)
      ? selectedSession
      : orderedTasks[0]?.session ?? null
  const current = tasks.find((t) => t.session === selected) ?? null

  // The open task's latest completed update, and whether the viewer is actively
  // viewing it (open + tab active + scrolled to the bottom where new content
  // lands). These drive the seen-marker advancement effect further below.
  const currentLatest = current ? latestUpdateAt(current) : ''
  const activelyViewing = !!current && tabActive && atBottom

  // The open task's conversation as a single stream: its messages in turn order,
  // merged with its lifecycle events by timestamp.
  //
  // We can't just sort messages by `createdAt`: a follow-up sent while the agent
  // is spinning up (queued, and so appended to the array) gets an earlier
  // timestamp than the assistant reply it's waiting on, because that reply's
  // timestamp is stamped lazily when claude's first token arrives (see the
  // server's ensurePending). Sorting by time would then float the follow-up
  // above the response it follows. Instead we pair turns positionally: every turn
  // is one user prompt answered by one assistant message, so the k-th assistant
  // belongs after the k-th user. Still-queued prompts have no assistant yet and
  // simply trail at the end, which is where they belong.
  type TimelineItem =
    | { kind: 'message'; at: string; message: Message; index: number }
    | { kind: 'event'; at: string; event: TaskEvent }
  const timeline: TimelineItem[] = []
  if (current) {
    const userIdx: number[] = []
    const asstIdx: number[] = []
    current.messages.forEach((m, i) =>
      (m.role === 'user' ? userIdx : asstIdx).push(i),
    )
    // Interleave user[k], assistant[k] in turn order; tolerate either list
    // running long (e.g. a stray legacy message) by emitting whatever remains.
    const ordered: TimelineItem[] = []
    const turns = Math.max(userIdx.length, asstIdx.length)
    for (let k = 0; k < turns; k++) {
      for (const i of [userIdx[k], asstIdx[k]]) {
        if (i === undefined) continue
        const message = current.messages[i]
        ordered.push({ kind: 'message', at: message.createdAt, message, index: i })
      }
    }
    // Splice lifecycle events into the turn-ordered stream by timestamp: each
    // event surfaces just before the first message it predates. Events are sparse
    // and mark deliberate status crossings (wedged/landed and their inverses), so
    // this reads naturally even where a trailing queued prompt sits out of strict
    // time order.
    const events = [...(current.events ?? [])].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    )
    let e = 0
    for (const item of ordered) {
      while (e < events.length && events[e].createdAt <= item.at)
        timeline.push({ kind: 'event', at: events[e].createdAt, event: events[e++] })
      timeline.push(item)
    }
    while (e < events.length)
      timeline.push({ kind: 'event', at: events[e].createdAt, event: events[e++] })
  }

  // The message indices of follow-ups still waiting in the queue. `queued` is
  // drained in order, so it always corresponds to the last N user messages —
  // dim those in the timeline to signal claude hasn't read them yet.
  const queuedIndices = new Set<number>()
  if (current) {
    let remaining = current.queued?.length ?? 0
    for (let i = current.messages.length - 1; i >= 0 && remaining > 0; i--) {
      if (current.messages[i].role === 'user') {
        queuedIndices.add(i)
        remaining--
      }
    }
  }

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
        headers: uiHeaders(),
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
      // Edits default on for the next task; commits stay as the user left them.
      setNewAllowEdits(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  // Leave edit mode (and close any tool popup) when switching tasks so neither
  // bleeds across them.
  useEffect(() => {
    setEditingTitle(false)
    setOpenTool(null)
    setOpenDiffs(new Set())
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
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
    atBottomRef.current = bottom
    setAtBottom(bottom)
  }

  // Changes whenever the open task's last (typically streaming) message grows,
  // even when the message count stays the same, so the effect re-pins as an
  // assistant turn fills in. The trailing fields track the two "claude is
  // working…" spinners (the per-message pending one and the standalone riding
  // one); they add and remove a row, so the timeline's height changes without
  // any message text changing and the effect must re-pin for those too.
  const lastMessage = current?.messages[current.messages.length - 1]
  const streamSignal = lastMessage
    ? `${lastMessage.steps?.length ?? 0}:` +
      `${lastMessage.steps?.reduce((n, s) => n + (s.text?.length ?? 0), 0) ?? 0}:` +
      `${lastMessage.text?.length ?? 0}:` +
      `${lastMessage.pending ? 1 : 0}:${current?.status}`
    : ''

  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    const switched = prevSelectedRef.current !== selected
    prevSelectedRef.current = selected
    if (switched) atBottomRef.current = true
    if (switched || atBottomRef.current) {
      el.scrollTop = el.scrollHeight
      // Pinning leaves us at the bottom; mirror that into the state the
      // active-viewing logic reads (a no-op when already true).
      setAtBottom(true)
    }
  }, [selected, current?.messages.length, current?.events?.length, streamSignal])

  // Move the open task's seen marker per the viewing rules. When the viewer
  // starts actively viewing a task (switches to it, focuses the tab, or scrolls
  // to the bottom), treat whatever's already there as a baseline and arm a 3s
  // dwell that marks it seen — so a glance that doesn't last doesn't clear the
  // dot. An update that arrives *while* actively viewing is past that baseline,
  // so it's marked seen at once.
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewSessionRef = useRef<string | null>(null)
  const viewBaselineRef = useRef<string>('')
  useEffect(() => {
    if (!activelyViewing || !current) {
      if (dwellTimerRef.current) {
        clearTimeout(dwellTimerRef.current)
        dwellTimerRef.current = null
      }
      viewSessionRef.current = null
      return
    }
    const session = current.session
    if (viewSessionRef.current !== session) {
      // Just began actively viewing this task: snapshot the baseline and arm the
      // dwell. Anything already present clears only once the 3s elapses.
      viewSessionRef.current = session
      viewBaselineRef.current = currentLatest
      if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current)
      dwellTimerRef.current = setTimeout(() => {
        dwellTimerRef.current = null
        void markSeen(session)
      }, 3000)
    } else if (currentLatest > viewBaselineRef.current) {
      // A new update landed while actively viewing — seen immediately.
      viewBaselineRef.current = currentLatest
      void markSeen(session)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activelyViewing, currentLatest, current?.session])

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

  // Grant a blocked tool call from its popup: "task" scope persists the rule on
  // the task (used on future turns), "project" scope writes it to the project's
  // settings.local.json. Close the popup either way; refresh so a task-scoped
  // grant shows up.
  async function allowTool(rule: string, scope: 'task' | 'project') {
    if (!current) return
    const id = current.session
    const proj = current.projectSlug
    setOpenTool(null)
    setError(null)
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}/allow`, {
        method: 'POST',
        headers: uiHeaders(),
        body: JSON.stringify({ rule, scope }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      if (scope === 'task') setTasks(await loadShownTasks(shown))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
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
        headers: uiHeaders(),
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
        headers: uiHeaders(),
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
          {orderedTasks.map((task, index) => {
            // The dot shows once the task has a seen marker (set on creation or
            // backfilled) and its latest completed update is newer than it.
            const unseen =
              task.seenAt != null && latestUpdateAt(task) > task.seenAt
            return (
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
              <div className="task-title-row">
                {unseen && (
                  <span
                    className="unseen-dot"
                    aria-label="Unviewed updates"
                    title="Unviewed updates"
                  />
                )}
                <div className="task-title">{task.title}</div>
                {showProjectLabels && (
                  <span className="task-project">
                    {lastPathComponent(
                      pathBySlug.get(task.projectSlug) ?? task.projectSlug,
                    )}
                  </span>
                )}
              </div>
              <div className="task-meta-row">
                <span
                  className={
                    'task-status' +
                    (task.status === 'wedged' ? ' wedged' : '') +
                    (task.status === 'riding' ? ' riding' : '') +
                    (task.status === 'resting' ? ' resting' : '') +
                    (task.status === 'landed' ? ' landed' : '')
                  }
                >
                  {task.status}
                </span>
              </div>
              <div className="task-time">
                {formatTimestamp(task.updatedAt ?? task.createdAt)}
              </div>
            </li>
            )
          })}
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
            {submitting ? 'Launching…' : 'Launch task'}
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
                <div className="detail-header-title">
                  {projects.length > 1 && (
                    <div className="detail-project">
                      {lastPathComponent(
                        pathBySlug.get(current.projectSlug) ??
                          current.projectSlug,
                      )}
                    </div>
                  )}
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
                      title="Regenerate title"
                      aria-label="Regenerate title"
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
                  </div>
                  )}
                </div>
                <div className="header-actions">
                  <button
                    className="wedged-button"
                    disabled={current.status === 'wedged'}
                    onClick={() => void setStatus('wedged')}
                  >
                    wedged
                  </button>
                  <button
                    className="resting-button"
                    disabled={
                      current.status !== 'wedged' && current.status !== 'landed'
                    }
                    onClick={() => void setStatus('resting')}
                  >
                    resting
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
                    (current.status === 'wedged' ? ' wedged' : '') +
                    (current.status === 'riding' ? ' riding' : '') +
                    (current.status === 'resting' ? ' resting' : '') +
                    (current.status === 'landed' ? ' landed' : '')
                  }
                >
                  {current.status}
                </span>
                <span className="task-time">
                  {formatTimestamp(current.updatedAt ?? current.createdAt)}
                </span>
              </div>
            </div>
            <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
              {timeline.map((item) => {
                if (item.kind === 'event') {
                  return (
                    <StatusTransition
                      key={`e-${item.event.kind}-${item.at}`}
                      event={item.event}
                    />
                  )
                }
                const m = item.message
                const i = item.index
                return (
                <div
                  className={`message message-${m.role}${queuedIndices.has(i) ? ' message-queued' : ''}`}
                  key={`m-${i}`}
                >
                  <div className="message-head">
                    <span className="message-role">{m.role}</span>
                    <span className="message-time">
                      {formatTimestamp(m.createdAt)}
                    </span>
                    {m.text && <CopyButton text={m.text} />}
                  </div>
                  {/* Streamed assistant turns render their live activity trace;
                      user and legacy messages just render their text. */}
                  {m.steps && m.steps.length > 0 ? (
                    <div className="steps">
                      {(() => {
                        // Map each tool call's id to its result outcome so a
                        // tool_use chip can show whether it was allowed/blocked,
                        // and to the tool that produced it so we can suppress a
                        // successful Edit's (noisy) result peek.
                        const outcomes = new Map<string, boolean>()
                        const toolById = new Map<string, string>()
                        for (const s of m.steps) {
                          if (s.kind === 'tool_result' && s.toolUseId)
                            outcomes.set(s.toolUseId, !!s.blocked)
                          if (s.kind === 'tool_use' && s.toolUseId && s.tool)
                            toolById.set(s.toolUseId, s.tool)
                        }
                        // Keys of every diff-bearing chip in this message, so an
                        // option/shift-click on one can toggle them all together.
                        const diffKeys = m.steps!
                          .map((s, j) =>
                            s.kind === 'tool_use' && s.edits?.length
                              ? `${i}:${j}`
                              : null,
                          )
                          .filter((k): k is string => k !== null)
                        return m.steps.map((s, j) => {
                          const key = `${i}:${j}`
                          const blocked = s.toolUseId
                            ? outcomes.get(s.toolUseId)
                            : undefined
                          const status: ToolStatus =
                            s.kind !== 'tool_use'
                              ? 'pending'
                              : blocked === undefined
                                ? 'pending'
                                : blocked
                                  ? 'blocked'
                                  : 'allowed'
                          // A successful Edit's result is just a confirmation/
                          // diff dump — skip it to keep the trace readable.
                          if (
                            s.kind === 'tool_result' &&
                            !s.isError &&
                            s.toolUseId &&
                            toolById.get(s.toolUseId) === 'Edit'
                          )
                            return null
                          return (
                            <Step
                              key={j}
                              step={s}
                              status={status}
                              open={openTool === key}
                              onToggle={() =>
                                setOpenTool(openTool === key ? null : key)
                              }
                              onClose={() => setOpenTool(null)}
                              onAllow={allowTool}
                              diffOpen={openDiffs.has(key)}
                              onToggleDiff={(all) =>
                                toggleDiff(key, all ? diffKeys : [key])
                              }
                            />
                          )
                        })
                      })()}
                    </div>
                  ) : (
                    m.text && (
                      <div className="message-text">
                        <Markdown text={m.text} />
                      </div>
                    )
                  )}
                  {m.pending && (
                    <div className="message-pending">
                      <span className="spinner" aria-hidden />
                      claude is working…
                    </div>
                  )}
                </div>
                )
              })}
              {/* No assistant message yet but the task is riding: claude has been
                  launched and we're waiting for its first output. */}
              {current.status === 'riding' &&
                current.messages[current.messages.length - 1]?.role ===
                  'user' && (
                  <div className="message-pending">
                    <span className="spinner" aria-hidden />
                    claude is working…
                  </div>
                )}
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
