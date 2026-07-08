import { Fragment, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { agentDisplayName, formatAgentModelName } from './agentDisplay'
import { Markdown } from './markdown'
import type { TaskLinkResolver } from './markdown'
import { buildTimeline } from './timeline'
import type { TimelineItem } from './timeline'
import { planTurnCollapse } from './turnCollapse'

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
  // text/tool_use: the id of the model inference that produced this block. A
  // change between consecutive steps marks a turn boundary — the model saw the
  // prior results and ran again — which we rule a line at. Absent on tool_result
  // steps and on steps recorded before the server emitted it.
  inferenceId?: string
  // Set on a subagent's steps (text/tool_use/tool_result alike): the id of the
  // Agent/Explore tool_use that spawned it. We fold a subagent's whole trace under
  // that spawning chip rather than splicing it into the main trace. Absent on the
  // main agent's own steps; nesting can run deep (a sub-subagent points at its
  // spawner), so these links form the tree.
  parentToolUseId?: string
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

// A tool call's outcome, read off its result: `blocked` was refused at the
// permission gate (it's in the turn's permission_denials), `failed` ran-or-tried
// and errored without being a denial, `ok` ran cleanly, `running` has no result
// yet. Only the two error states (blocked/failed) get a red badge and a status
// word; a clean call shows just its command, no "approved"/"success" affirmation.
type ToolStatus = 'ok' | 'blocked' | 'failed' | 'running'

// Token counts a turn consumed, accumulated as it streams and finalized by its
// result event. `input` and `cacheCreation` are fresh input processed this turn
// (uncached); `cacheRead` is the discounted re-read of cached context. `model`
// is the session's driving (main-agent) model. `costUsd` is the turn's dollar
// cost, present only once the turn lands. Shown in the composer's corner — latest
// turn, or summed across the task — updating live as the turn runs.
type TokenUsage = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  model?: string
  costUsd?: number
  // Why the turn's prompt cache missed, when the API reported one: the reason
  // type and the tokens re-processed instead of read from cache. Shown in the
  // turn-scope tooltip; absent on a clean cache hit and for Codex turns.
  cacheMiss?: { reason: string; missedTokens: number }
}

type Message = {
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  steps?: Step[]
  usage?: TokenUsage
  pending?: boolean
  // Set by the server (publicTask) on a follow-up the agent hasn't read yet; the
  // timeline dims it and sinks it below the conversation.
  queued?: boolean
}

// A lifecycle event interleaved with messages in the conversation timeline: the
// task's launch, a rename, or a crossing into/out of the wedged (needs the
// user) or terminal landed state. `title` is the task's name as of the event
// (absent on an untitled launch or on events saved before titles were captured).
type TaskEvent = {
  kind:
    | 'launched'
    | 'scheduled'
    | 'awaiting'
    | 'wedged'
    | 'unwedged'
    | 'landed'
    | 'unlanded'
    | 'renamed'
    // The divider `lander relaunch` records when it seals the assistant session.
    // An armed scheduled relaunch carries `scheduledFor` (the pending indicator);
    // the divider recorded on delivery does not.
    | 'relaunched'
  title?: string
  // 'scheduled' (and an armed 'relaunched') only: when the task is set to
  // launch/relaunch, shown beside the verb.
  scheduledFor?: string
  // 'awaiting' only: the tasks this one is resting on, rendered as links.
  awaiting?: { id: string; title: string }[]
  createdAt: string
}

type Task = {
  // The task's own short id (a nanoid; legacy tasks carry the uuid they were
  // keyed by). Distinct from the provider session that backs its turns, which
  // the daemon owns and the client never sees.
  id: string
  agent: 'claude' | 'codex'
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
  // Set on tasks the server reads from the archive dir (when the list is
  // fetched with ?archived=1). Marks the row and swaps the kebab's Archive item
  // for Restore. Absent on active tasks.
  archived?: boolean
  // ISO timestamp a scheduled task is set to launch; present only while the
  // task is resting and waiting for the server's scheduler (or a manual launch).
  scheduledFor?: string
  // Task ids this task is resting on (`--await`); the scheduler launches it once
  // all have landed. Present only while awaiting; may coexist with scheduledFor.
  waitingFor?: string[]
  // Deferred messages armed on this task (`lander send/relaunch --date/--time/
  // --await`), each firing on its own trigger. We read `relaunch` (a pending
  // scheduled relaunch, shown as the scheduled clock alongside scheduledFor/
  // waitingFor) and `repeat` (a `--interval` relaunch, shown as the clockwise
  // arrow beside it).
  scheduledMessages?: {
    relaunch?: boolean
    deliverAt?: string
    waitFor?: string[]
    repeat?: unknown
  }[]
  messages: Message[]
  events?: TaskEvent[]
  // Present only when the task wedged on an assistant error (not the agent's own
  // wedge): drives the retry button below the conversation. `committed` is
  // whether the failed turn's prompt reached the session — true means a retry
  // nudges the session ("Try again"), false means it re-sends the un-received
  // prompt ("Resend"). `resetsAt` is set when the wedge was a session-limit
  // rejection: while it's still in the future the button instead schedules the
  // retry for then. See the server's Task.retry for the full rationale.
  retry?: { committed: boolean; prompts: string[]; resetsAt?: string }
  // The working directory the previous turn ended in, recorded by the Stop hook
  // (see the server's Task.cwd). When it's a git worktree the agent entered, its
  // name shows beside the project in the detail header. Absent until the first
  // turn completes, or when the task never left the project root.
  cwd?: string
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

// useState that mirrors itself to localStorage under `key`, so the value
// survives a dev hot reload, a full page reload, or accidental navigation —
// without which an in-progress draft (a half-typed task or reply) is lost the
// moment React Fast Refresh remounts the component. The stored value is JSON;
// every store access tolerates an unavailable or corrupt store (private mode,
// quota) by falling back to `initial`. Drives only deliberately-kept *draft*
// state — ephemeral UI (open menus, popups, focus) is left to reset.
// The list's time window: tasks updated today, this week (from Sunday), before
// this week ('older', same Sunday cutoff), or with no bound. 'today'/'week'/
// 'older' also surface in the dropdown title.
type TimeFilter = 'today' | 'week' | 'older' | 'any'
// Which slice of tasks the list shows: 'inbox' (everything not archived, the
// default), 'unread' (just the inbox tasks with unviewed updates), or
// 'archived'. Mutually exclusive, chosen from the project filter dropdown.
type TaskView = 'inbox' | 'unread' | 'archived'

function usePersistentState<T>(
  key: string,
  initial: T,
  store: Storage = localStorage,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = store.getItem(key)
      return raw != null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      store.setItem(key, JSON.stringify(value))
    } catch {
      // storage unavailable — the value simply won't persist
    }
  }, [key, value])
  return [value, setValue]
}

// Like usePersistentState but backed by sessionStorage, which is scoped to a
// single tab: the value survives a hot reload or refresh within that tab, yet
// two tabs keep independent values (and each is dropped when its tab closes).
// Used for view state a user reasonably expects to differ per tab — the list
// filters and the per-tab drafts they're composing — rather than a global
// preference, which stays on localStorage so it holds everywhere at once.
function useSessionState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  return usePersistentState(key, initial, sessionStorage)
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

// The task list shows the full date+time for older rows but, for tasks updated
// today, just the time — the "Today" date header already supplies the day.
function formatTaskTime(iso: string, todayStart: number): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const time = { hour: 'numeric', minute: '2-digit' } as const
  if (d.getTime() >= todayStart) return d.toLocaleTimeString([], time)
  const date = d.toLocaleDateString([], {
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    month: 'numeric',
    day: 'numeric',
  })
  return `${date} • ${d.toLocaleTimeString([], time)}`
}

type DateCategory = 'today' | 'week' | 'older'

// Bucket a timestamp into the list's date sections: today (>= local midnight),
// this week (>= the preceding Sunday), or older.
function dateCategory(
  iso: string,
  todayStart: number,
  weekStart: number,
): DateCategory {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts) || ts < weekStart) return 'older'
  if (ts >= todayStart) return 'today'
  return 'week'
}

const DATE_CATEGORY_LABELS: Record<DateCategory, string> = {
  today: 'Today',
  week: 'This week',
  older: 'Older',
}

// "/Users/me/code/myapp" -> "myapp"; the leaf is enough to tell projects apart
// in the task list without showing the whole path.
function lastPathComponent(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

// The name of the git worktree a task's cwd sits in, or null when it's not in
// one. Claude Code's `--worktree` flag roots worktrees at `.claude/worktrees/
// <name>`, so the name is the path segment right after that marker (the cwd may
// be a deeper subdirectory of the worktree, hence the index lookup rather than
// a plain last component).
function worktreeName(cwd: string | undefined): string | null {
  if (!cwd) return null
  const parts = cwd.split('/').filter(Boolean)
  const i = parts.lastIndexOf('worktrees')
  if (i < 1 || parts[i - 1] !== '.claude') return null
  return parts[i + 1] ?? null
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

// Whether a task has unviewed updates: it carries a seen marker (set on
// creation or backfilled) and its latest completed update is newer than it.
// Drives the unseen dot, the kebab's "Mark unread" item, and the "Unread"
// filter view. A task with no marker yet reads as caught up.
function isUnread(task: Task): boolean {
  return task.seenAt != null && latestUpdateAt(task) > task.seenAt
}

// Abbreviate a token count for the compact corner readout: exact below 1,000,
// then whole "k" up to a million ("35k"), then whole "M" beyond ("4M").
function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${Math.round(n / 1_000_000)}M`
}

// A dollar cost for the corner readout: two decimals up to $100 ("$0.07",
// "$1.23"), then whole dollars beyond ("$1,204") where the cents are noise.
function formatCost(n: number): string {
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString()}`
}

function taskAgentModelName(agent: Task['agent'], model?: string): string {
  return formatAgentModelName(agentDisplayName(agent), model)
}

// The token usage of the task's most recent turn that reported any — the last
// assistant message carrying a `usage`. A streaming turn reports its usage live
// (summed across inferences so far), so this tracks the in-flight turn as it
// grows rather than lagging a turn behind.
function latestUsage(task: Task): TokenUsage | undefined {
  for (let i = task.messages.length - 1; i >= 0; i--) {
    const u = task.messages[i].usage
    if (u) return u
  }
  return undefined
}

// Token usage summed across every turn of the task. The token counts and dollar
// cost add up; the model is taken from the latest turn (the task's current
// model), matching what the per-turn view shows. Cost stays undefined until some
// turn reports one (a turn still streaming hasn't). Undefined when no turn has
// reported usage at all.
function totalUsage(task: Task): TokenUsage | undefined {
  const total = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  let cost: number | undefined
  let any = false
  for (const m of task.messages) {
    const u = m.usage
    if (!u) continue
    any = true
    total.input += u.input
    total.output += u.output
    total.cacheRead += u.cacheRead
    total.cacheCreation += u.cacheCreation
    if (u.costUsd !== undefined) cost = (cost ?? 0) + u.costUsd
  }
  if (!any) return undefined
  return { ...total, model: latestUsage(task)?.model, costUsd: cost }
}

// The selected task's project is the first path segment, e.g.
// "/users-me-code-app/task1/" -> "users-me-code-app". Empty on "/".
function slugFromPath(): string {
  return window.location.pathname.split('/').filter(Boolean)[0] ?? ''
}

// The selected task's id is the second path segment, e.g.
// "/users-me-code-app/task1/" -> "task1". Empty when no task is in the URL.
function taskIdFromPath(): string {
  return window.location.pathname.split('/').filter(Boolean)[1] ?? ''
}

// A clock time like "3:45 PM" for when a window resets. The upstream reset
// moment carries sub-second jitter around its true boundary (e.g. the 03:00:00
// reset arrives as anything from 02:59:59.98 to 03:00:00.8), so round to the
// nearest minute rather than truncating — otherwise the readout flickers
// between adjacent minutes (2:59 ↔ 3:00) as the value straddles the boundary.
function formatResetTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  d.setSeconds(d.getSeconds() + 30)
  d.setSeconds(0, 0)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// A wedged task's session-limit reset time, formatted as a clock time, but only
// while it's still in the future — the moment a retry should wait for rather than
// firing into the same limit. Undefined once the limit has lifted (so the retry
// button reverts to retrying immediately) or when the wedge wasn't rate-limited.
function retryResetTime(retry?: { resetsAt?: string }): string | undefined {
  const at = retry?.resetsAt
  if (!at || Date.parse(at) <= Date.now()) return undefined
  return formatResetTime(at)
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
  // Two bands: low (landed) under 90, high (wedged) at 90 and above.
  const level = pct >= 90 ? 'high' : ''
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

// Compact Claude subscription usage shown under the new-task form: the current
// 5-hour session window and the 7-day weekly window, each a small progress bar
// with its reset time. The snapshot rides in on every tasks poll (the server
// owns when to refresh it from upstream), so this is purely presentational.
function UsageSummary({
  usage,
  agent,
}: {
  usage: Usage | null
  agent?: Task['agent']
}) {
  if (agent === 'codex')
    return (
      <div className="usage-summary usage-unsupported">
        Codex subscription usage unsupported
      </div>
    )
  // Stay quiet until we have something to show; a missing token or endpoint
  // error leaves usage null, which shouldn't clutter the sidebar.
  if (!usage || (!usage.session && !usage.weekly)) return null

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
  agent,
  allowable,
  anchor,
  onAllow,
}: {
  step: Step
  status: ToolStatus
  agent: Task['agent']
  // Whether to offer the allow buttons. True when the call was refused at the
  // permission gate, or it errored before the turn's permission_denials list
  // arrived (so we can't yet tell a refusal from a plain failure — offer the
  // grant rather than hide it prematurely). False once the list confirms the
  // error was not a denial, and for clean or still-running calls.
  allowable: boolean
  // Viewport coords of the chip's bottom-left, so the fixed-position popup can
  // anchor under the chip while escaping the scrolling timeline's clipping.
  anchor: { top: number; left: number }
  onAllow: (rule: string, scope: 'task' | 'project') => void
}) {
  // `rule` is computed server-side (see toolRule). Steps saved before that field
  // existed fall back to the bare tool name; they predate blocked/isError too, so
  // they never offer the allow buttons anyway — the textarea is just a view.
  const [rule, setRule] = useState(step.rule ?? step.tool ?? '')
  // Only an error carries a status word: a refusal reads "blocked", any other
  // error "failed". A clean or still-running call shows just its rule.
  const label =
    status === 'blocked' ? 'blocked' : status === 'failed' ? 'failed' : ''
  const codex = agent === 'codex'
  return (
    <div
      className="tool-popup"
      style={{ top: anchor.top, left: anchor.left }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="tool-popup-head">
        <span className="tool-popup-tool">{step.tool}</span>
        {label && <span className="tool-popup-status">{label}</span>}
      </div>
      <textarea
        className="tool-popup-input"
        rows={3}
        value={rule}
        onChange={(e) => setRule(e.target.value)}
      />
      {allowable && (
        <div className="tool-popup-actions">
          <button
            type="button"
            title={
              codex
                ? 'Saved for parity; Codex runs do not honor task allow rules yet'
                : undefined
            }
            onClick={() => onAllow(rule, 'task')}
          >
            {codex ? 'save rule' : 'allow in task'}
          </button>
          <button
            type="button"
            title={
              codex
                ? 'Project grants are not supported for Codex tasks yet'
                : undefined
            }
            onClick={() => onAllow(rule, 'project')}
          >
            {codex ? 'project unsupported' : 'allow in project'}
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

// A disclosure: a triangle that rotates open, with revealable content dropping
// below behind a line down its left that marks the section's scope. The triangle
// either carries its own `label` (e.g. a turn's "12 STEPS…" summary) or sits
// beside an independently-clickable `summary` (e.g. a tool chip, which has its
// own click action). Both the tool detail and the turn fold render through this,
// so they share one look. `onToggle` gets the click event so a caller can read
// modifier keys.
function Collapsible({
  open,
  onToggle,
  label,
  summary,
  toggleTitle,
  toggleLabel,
  children,
}: {
  open: boolean
  onToggle: (e: React.MouseEvent) => void
  label?: React.ReactNode
  summary?: React.ReactNode
  toggleTitle?: string
  toggleLabel?: string
  children?: React.ReactNode
}) {
  return (
    <div className="collapsible">
      <div className="collapsible-row">
        <button
          type="button"
          className="collapsible-toggle"
          aria-expanded={open}
          aria-label={toggleLabel}
          title={toggleTitle}
          onClick={onToggle}
        >
          <span className={'step-diff-caret' + (open ? ' open' : '')}>▶</span>
          {label}
        </button>
        {summary}
      </div>
      {open && children && (
        <div className="collapsible-body">{children}</div>
      )}
    </div>
  )
}

// A tool call in the activity trace: a clickable chip (red when the call was
// blocked or failed) that toggles a grant popup. When the chip has revealable detail — a
// file-writing tool's diff, or any other tool's captured output — it also gets
// a disclosure triangle to its left that expands it (default closed);
// option/shift-clicking toggles every such chip in the message at once. The chip
// + popup share one ref so an outside click — anywhere but here — dismisses the
// popup.
function ToolStep({
  step,
  status,
  allowable,
  result,
  open,
  onToggle,
  onClose,
  onAllow,
  detailOpen,
  onToggleDetail,
  agent,
  subSteps,
}: {
  step: Step
  status: ToolStatus
  allowable: boolean
  // The matching tool_result's text/error, folded in so the chip can reveal it.
  result?: { text?: string; isError?: boolean }
  open: boolean
  onToggle: () => void
  onClose: () => void
  onAllow: (rule: string, scope: 'task' | 'project') => void
  detailOpen: boolean
  // `all` is set when the user option/shift-clicked, asking to toggle every
  // detail in the message rather than just this one.
  onToggleDetail: (all: boolean) => void
  agent: Task['agent']
  // A subagent-spawning call (Agent/Explore) gets its subagent's whole activity
  // trace as its revealable detail, pre-rendered by the caller. Absent otherwise.
  subSteps?: React.ReactNode
}) {
  const hasDiff = !!step.edits && step.edits.length > 0
  // A subagent spawner reveals the nested trace; an edit reveals its diff;
  // everything else reveals its captured output (if any — a still-running call has
  // none yet). The trace subsumes the call's result text (it ends with the
  // subagent's final reply), and the diff wins over an Edit's noisy confirmation.
  const hasChildren = !!subSteps
  const hasResult = !hasDiff && !hasChildren && !!result?.text
  const hasDetail = hasDiff || hasChildren || hasResult
  const noun = hasDiff ? 'diff' : hasChildren ? 'activity' : 'output'
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

  // The chip (and its input) read the same whether or not the call has revealable
  // detail; when it does, they ride beside the disclosure triangle as its summary.
  const chip = (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={
          'step-tool-name' +
          (status === 'blocked' || status === 'failed' ? ' errored' : '')
        }
        aria-expanded={open}
        onClick={onToggle}
      >
        {step.tool}
      </button>
      {step.input && <span className="step-tool-input">{step.input}</span>}
    </>
  )
  return (
    <div className="step-tool" ref={ref}>
      {hasDetail ? (
        <Collapsible
          open={detailOpen}
          onToggle={(e) => onToggleDetail(e.altKey || e.shiftKey)}
          summary={chip}
          toggleLabel={`${detailOpen ? 'Hide' : 'Show'} ${noun}`}
          toggleTitle={`${detailOpen ? 'Hide' : 'Show'} ${noun} (⌥/⇧ for all)`}
        >
          {hasDiff && <DiffView edits={step.edits!} />}
          {hasChildren && <div className="steps sub-steps">{subSteps}</div>}
          {hasResult && (
            <div
              className={'step-result' + (result!.isError ? ' errored' : '')}
            >
              {result!.text}
            </div>
          )}
        </Collapsible>
      ) : (
        <div className="collapsible-row">{chip}</div>
      )}
      {open && anchor && (
        <ToolPopup
          step={step}
          status={status}
          agent={agent}
          allowable={allowable}
          anchor={anchor}
          onAllow={onAllow}
        />
      )}
    </div>
  )
}

// One entry in a streamed assistant turn: prose as markdown, a tool call as a
// clickable chip, or a dimmed peek at a tool result.
function Step({
  step,
  status,
  allowable,
  result,
  open,
  onToggle,
  onClose,
  onAllow,
  detailOpen,
  onToggleDetail,
  linkTask,
  agent,
  subSteps,
}: {
  step: Step
  status: ToolStatus
  allowable: boolean
  result?: { text?: string; isError?: boolean }
  open: boolean
  onToggle: () => void
  onClose: () => void
  onAllow: (rule: string, scope: 'task' | 'project') => void
  detailOpen: boolean
  onToggleDetail: (all: boolean) => void
  linkTask: TaskLinkResolver
  agent: Task['agent']
  // A subagent spawner's nested trace, pre-rendered by the caller; passed through
  // to ToolStep as the chip's revealable detail.
  subSteps?: React.ReactNode
}) {
  if (step.kind === 'tool_use') {
    return (
      <ToolStep
        step={step}
        status={status}
        allowable={allowable}
        result={result}
        open={open}
        onToggle={onToggle}
        onClose={onClose}
        onAllow={onAllow}
        detailOpen={detailOpen}
        onToggleDetail={onToggleDetail}
        agent={agent}
        subSteps={subSteps}
      />
    )
  }
  if (step.kind === 'tool_result') {
    return step.text ? <div className="step-result">{step.text}</div> : null
  }
  return <MessageText text={step.text ?? ''} linkTask={linkTask} />
}

// How each lifecycle event verb reads in the timeline.
const EVENT_VERB: Record<TaskEvent['kind'], string> = {
  launched: 'launched',
  scheduled: 'scheduled',
  awaiting: 'awaiting',
  wedged: 'wedged',
  unwedged: 'un-wedged',
  landed: 'landed',
  unlanded: 'un-landed',
  renamed: 'renamed',
  relaunched: 'relaunched',
}

// A lifecycle event shown inline in the conversation: the task's name (as of
// that moment) followed by the verb — e.g. "Fix the parser launched". The name
// is italic and the verb is set apart by weight/color (each verb wears its
// status color — launched like riding, wedged, landed — plain otherwise).
// Presented like the
// working-spinner row (unbubbled, muted) but without the spinner, since the
// event is complete.
function StatusTransition({
  event,
  slug,
  linkTask,
}: {
  event: TaskEvent
  slug: string
  linkTask: TaskLinkResolver
}) {
  // An "awaiting" event reads "<name> awaiting <task>" with the awaited task
  // linked; with several, it reads "<name> awaiting <N> tasks" and lists them as
  // links below. Any time fallback the task also has isn't shown — the condition
  // is the point.
  if (event.kind === 'awaiting') {
    const tasks = event.awaiting ?? []
    const single = tasks.length === 1
    // Tint each awaited link by its task's current status (when resolvable),
    // matching the status chips used for task mentions.
    const link = (t: { id: string; title: string }) => {
      const status = linkTask(t.id)?.status
      return (
        <a
          className={`status-transition-await-link${status ? ` ${status}` : ''}`}
          href={`/${slug}/${t.id}`}
        >
          {t.title}
        </a>
      )
    }
    return (
      <div className="status-transition status-transition-awaiting">
        <div className="status-transition-await-head">
          <span className="status-transition-event">
            {event.title && (
              <span className="status-transition-name">{event.title}</span>
            )}
            <span className="status-transition-label awaiting">
              awaiting{single ? '' : ` ${tasks.length} tasks`}
            </span>
            {single && link(tasks[0])}
          </span>
          <span className="status-transition-time">
            {formatTimestamp(event.createdAt)}
          </span>
        </div>
        {!single && (
          <ul className="status-transition-await-list">
            {tasks.map((t) => (
              <li key={t.id}>{link(t)}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }
  return (
    <div className="status-transition">
      <span className="status-transition-event">
        {event.title && (
          <span className="status-transition-name">{event.title}</span>
        )}
        <span className={`status-transition-label ${event.kind}`}>
          {EVENT_VERB[event.kind]}
          {/* A 'scheduled' rest and an armed scheduled 'relaunch' both show the
              time they'll fire beside the verb. */}
          {(event.kind === 'scheduled' || event.kind === 'relaunched') &&
            event.scheduledFor && (
              <span className="status-transition-when">
                {' '}
                {formatTimestamp(event.scheduledFor)}
              </span>
            )}
        </span>
      </span>
      <span className="status-transition-time">
        {formatTimestamp(event.createdAt)}
      </span>
    </div>
  )
}

// A clipboard button shown beside a rendered text block. Briefly flips to a
// checkmark after a successful copy so the click registers.
function CopyButton({
  text,
  className = 'message-text-copy',
  title = 'Copy message text',
}: {
  text: string
  className?: string
  title?: string
}) {
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
      className={className}
      onClick={copy}
      title={title}
      aria-label={copied ? 'Copied' : title}
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

function MessageText({
  text,
  linkTask,
}: {
  text: string
  linkTask: TaskLinkResolver
}) {
  if (!text) return null
  return (
    <div className="message-text-wrap">
      <div className="message-text">
        <Markdown text={text} linkTask={linkTask} />
      </div>
      <CopyButton text={text} />
    </div>
  )
}

// A clipboard button for copying a task's id, styled to sit beside the
// title's sparkle and fade in with it on hover. Flips to a checkmark after a
// successful copy so the click registers.
function CopyIdButton({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied (e.g. insecure context); ignore.
    }
  }
  return (
    <button
      type="button"
      className="edit-title-button"
      onClick={copy}
      title="Copy task ID"
      aria-label={copied ? 'Copied' : 'Copy task ID'}
    >
      {copied ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M20 6 9 17l-5-5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
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

// The status actions a task's kebab menu can fire, mirroring the buttons the
// detail header used to carry, plus archive/restore.
type TaskAction =
  | 'launch'
  | 'wedge'
  | 'rest'
  | 'land'
  | 'copyId'
  | 'markUnread'
  | 'archive'
  | 'restore'

// The non-status actions that sit below a separator at the foot of the kebab
// menu. A single divider is drawn before the first of these that appears.
const FOOTER_ACTIONS = new Set<TaskAction>(['copyId', 'markUnread', 'archive'])

// The kebab (⋮) menu on a task list row. It carries the status actions that
// used to live as buttons in the detail header, plus Archive/Restore — but only
// the items that would be both *visible and enabled* for the task's current
// status, so e.g. a landed task offers Wedge/Rest/Archive but not Land. An
// archived task collapses to a single Restore. The button stops click
// propagation so opening the menu doesn't also select the row, and the menu is
// fixed-positioned (anchored to the button's live rect, re-measured on
// scroll/resize) so the scrolling task list can't clip it.
function TaskActionsMenu({
  task,
  onAction,
}: {
  task: TaskWithProject
  onAction: (action: TaskAction) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  )

  // Build the items from the same per-status rules the header buttons encoded:
  //  - launch:  a scheduled task (scheduledFor set, resting or wedged), to run it early
  //  - wedge:   any task not already wedged
  //  - rest:    a wedged or landed task, to return it to rest
  //  - land:       any task not already landed
  //  - copyId:     any task, to copy its id to the clipboard
  //  - markUnread: any task that isn't already showing unviewed updates
  //  - archive:    any non-riding task (a riding one has a live run)
  const items: { action: TaskAction; label: string }[] = []
  if (task.archived) {
    items.push({ action: 'restore', label: 'Restore' })
  } else {
    if (task.scheduledFor) items.push({ action: 'launch', label: 'Launch' })
    if (task.status !== 'wedged') items.push({ action: 'wedge', label: 'Wedge' })
    if (task.status === 'wedged' || task.status === 'landed')
      items.push({ action: 'rest', label: 'Rest' })
    if (task.status !== 'landed') items.push({ action: 'land', label: 'Land' })
    items.push({ action: 'copyId', label: 'Copy ID' })
    if (!isUnread(task))
      items.push({ action: 'markUnread', label: 'Mark unread' })
    if (task.status !== 'riding')
      items.push({ action: 'archive', label: 'Archive' })
  }

  useEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect()
      if (r) setAnchor({ top: r.bottom + 4, left: r.left })
    }
    place()
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Move focus into the menu once it's mounted (anchor placed), so the arrow
  // keys have somewhere to start.
  useEffect(() => {
    if (open && anchor) itemRefs.current[0]?.focus()
  }, [open, anchor])

  // Roving arrow-key navigation within the open menu. Each key is stopped from
  // bubbling to the row's own key handler (which would move row focus or select
  // the task); Enter/Space fall through to the focused item's click.
  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const count = items.length
    const focusAt = (i: number) =>
      itemRefs.current[((i % count) + count) % count]?.focus()
    const idx = itemRefs.current.findIndex((el) => el === document.activeElement)
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        e.stopPropagation()
        focusAt(idx + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        e.stopPropagation()
        focusAt(idx < 0 ? count - 1 : idx - 1)
        break
      case 'Home':
        e.preventDefault()
        e.stopPropagation()
        focusAt(0)
        break
      case 'End':
        e.preventDefault()
        e.stopPropagation()
        focusAt(count - 1)
        break
      case 'Enter':
      case ' ':
        e.stopPropagation()
        break
      case 'Escape':
        e.stopPropagation()
        setOpen(false)
        buttonRef.current?.focus()
        break
    }
  }

  if (items.length === 0) return null

  return (
    <div className="task-menu" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className="task-kebab"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Task actions"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        // Keep Enter/Space (and arrows) from bubbling to the row's key handler,
        // which would otherwise select the task or move row focus.
        onKeyDown={(e) => e.stopPropagation()}
      >
        ⋮
      </button>
      {open && anchor && (
        <div
          className="task-menu-popup"
          role="menu"
          style={{ top: anchor.top, left: anchor.left }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((it, i) => (
            <Fragment key={it.action}>
              {/* Set the footer actions (Copy ID, Mark unread, Archive) apart
                  from the status actions above with a single separator before
                  the first of them. */}
              {i > 0 &&
                FOOTER_ACTIONS.has(it.action) &&
                !FOOTER_ACTIONS.has(items[i - 1].action) && (
                  <div className="task-menu-sep" role="separator" />
                )}
              <button
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`task-menu-item task-menu-item-${it.action}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                  onAction(it.action)
                }}
              >
                {it.label}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

// The kebab on a section header (a status, or a date subheader within a split
// status). Its one action archives every task in that section at once. Shares the
// row kebab's trigger and popup styling, opening the popup down and to the right
// from the trigger like the task menu; with a single item it skips the roving
// navigation.
function SectionActionsMenu({
  count,
  onArchive,
}: {
  count: number
  onArchive: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const itemRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  )

  useEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect()
      if (r) setAnchor({ top: r.bottom + 4, left: r.left })
    }
    place()
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Focus the single item once the popup is placed, so Escape/Enter land on it.
  useEffect(() => {
    if (open && anchor) itemRef.current?.focus()
  }, [open, anchor])

  return (
    <div className="task-menu section-menu" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className="task-kebab"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Section actions"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        ⋮
      </button>
      {open && anchor && (
        <div
          className="task-menu-popup"
          role="menu"
          style={{ top: anchor.top, left: anchor.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            ref={itemRef}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="task-menu-item task-menu-item-archive"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
              onArchive()
            }}
          >
            Archive {count} {count === 1 ? 'task' : 'tasks'}
          </button>
        </div>
      )}
    </div>
  )
}

export function App() {
  const [tasks, setTasks] = useState<TaskWithProject[]>([])
  // Active + archived tasks across shown projects, used only to resolve
  // task-id mentions to links. The displayed `tasks` list holds just the
  // current view's set (active OR archived — they come from separate
  // endpoints), so without this an archived id referenced from an inbox
  // message — or vice versa — wouldn't link.
  const [linkTasks, setLinkTasks] = useState<TaskWithProject[]>([])
  // Account usage, carried on every tasks poll. The server decides when to
  // refresh it from upstream (on turn-end and at each window reset); the client
  // just shows the latest snapshot it was handed.
  const [usage, setUsage] = useState<Usage | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  // The project dropdown acts as a filter: `shown` holds the slugs whose tasks
  // are merged into the list. It is always either a single project or every
  // project ("show all"); see showOnly/showAll below. Session-scoped so it
  // survives a reload but stays per-tab; reconciled against the live project
  // list once it loads (see the /api/projects effect).
  const [shown, setShown] = useSessionState<string[]>('lander:shown', [])
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // The list's task-slice filter (see TaskView), session-scoped so it survives
  // a reload but can differ per tab.
  const [view, setView] = useSessionState<TaskView>('lander:view', 'inbox')
  // The list's time-window filter (see TimeFilter), session-scoped alongside view.
  const [timeFilter, setTimeFilter] = useSessionState<TimeFilter>(
    'lander:timeFilter',
    'any',
  )
  // The user's explicit task pick. The effective selection (`selected`, below)
  // falls back to the first visible task when this one is filtered away.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    () => taskIdFromPath() || null,
  )
  const [error, setError] = useState<string | null>(null)
  // The list search box, session-scoped alongside the other list filters.
  const [filter, setFilter] = useSessionState('lander:filter', '')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // The new-task form's draft fields persist across reloads so a half-composed
  // task — its message and its agent/edit/commit/project choices — isn't lost
  // to a hot reload or refresh. Session-scoped: two tabs composing different
  // tasks keep independent drafts (localStorage would let them clobber each
  // other, and since these fields drive the submission, a shared newProject
  // could even send a task to the wrong project).
  const [message, setMessage] = useSessionState('lander:draft:newTask', '')
  const [newAllowEdits, setNewAllowEdits] = useSessionState(
    'lander:draft:newAllowEdits',
    true,
  )
  const [newAllowCommits, setNewAllowCommits] = useSessionState(
    'lander:draft:newAllowCommits',
    false,
  )
  const [newTaskAgent, setNewTaskAgent] = useSessionState<Task['agent']>(
    'lander:draft:newAgent',
    'claude',
  )
  // Explicit project override for the new-task form; empty means "follow the
  // default" (targetSlug below).
  const [newProject, setNewProject] = useSessionState(
    'lander:draft:newProject',
    '',
  )
  // Whether the corner usage readout sums across the whole task or shows just
  // the latest turn. Clicking it toggles; persisted so the choice sticks.
  const [usageTotal, setUsageTotal] = usePersistentState(
    'lander:usageTotal',
    false,
  )
  const [submitting, setSubmitting] = useState(false)

  // Each task keeps its own draft and in-flight state, keyed by id, so you
  // can start a reply in one task, switch away, and come back to finish it; the
  // drafts persist across reloads alongside the new-task message and, like it,
  // are session-scoped so two tabs don't clobber each other's reply drafts.
  const [replies, setReplies] = useSessionState<Record<string, string>>(
    'lander:draft:replies',
    {},
  )
  const [sendingBy, setSendingBy] = useState<Record<string, boolean>>({})
  const [retryingBy, setRetryingBy] = useState<Record<string, boolean>>({})
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // The tool chip whose grant popup is open, keyed "<messageIndex>:<stepIndex>".
  // Only one is open at a time; null means none.
  const [openTool, setOpenTool] = useState<string | null>(null)

  // The set of tool chips whose detail (a diff or captured output) is revealed,
  // keyed the same "<messageIndex>:<stepIndex>". Details start closed and several
  // can be open at once (option/shift-click toggles a whole message's worth).
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set())

  // Toggle one chip's detail, or — when option/shift was held — every detail in
  // its message together, driving them all to this chip's new (opposite) state.
  function toggleDetail(key: string, messageKeys: string[]) {
    setOpenDetails((prev) => {
      const next = new Set(prev)
      const willOpen = !prev.has(key)
      for (const k of messageKeys) {
        if (willOpen) next.add(k)
        else next.delete(k)
      }
      return next
    })
  }

  // Assistant turns (other than the most recent) collapse their middle stretch of
  // message steps behind a disclosure; this holds the message indices the viewer
  // has expanded. It's cleared on task switch, so each task opens with its history
  // folded down again.
  const [expandedTurns, setExpandedTurns] = useState<Set<number>>(new Set())

  function toggleTurn(messageIndex: number) {
    setExpandedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(messageIndex)) next.delete(messageIndex)
      else next.add(messageIndex)
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

  // Whether DOM focus currently rests on a row inside the task list. While it
  // does, the Unread view holds onto tasks the viewer reads in place (see the
  // sticky-unread set below) so the list doesn't reshuffle under the keyboard;
  // moving focus to a text field or another window drops that hold.
  const [listFocused, setListFocused] = useState(false)
  // Tasks to keep in the Unread view even though they've been read, because
  // they were read while the list held focus. Accrues every unread task seen
  // during a focused spell and clears when focus leaves the list, at which point
  // the plain unread filter reapplies. Newly-unread tasks need no entry here —
  // they pass the filter on their own — but joining the set keeps them visible
  // if the viewer then reads them without leaving the list.
  const [stickyUnread, setStickyUnread] = useState<Set<string>>(new Set())

  // Latest tasks readable from timer callbacks that outlive the render that
  // scheduled them (the dwell timer below marks a task seen 2s later).
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

  // Maintain the sticky-unread set. Outside the focused Unread view it stays
  // empty (so the filter is the plain one). While the list holds focus on the
  // Unread view, fold every currently-unread task into it — including ones
  // that just arrived — so that reading a task (which clears its unread mark)
  // leaves it in the list rather than yanking it out from under the cursor.
  useEffect(() => {
    if (view !== 'unread' || !listFocused) {
      setStickyUnread((prev) => (prev.size ? new Set() : prev))
      return
    }
    setStickyUnread((prev) => {
      let next = prev
      for (const t of tasks) {
        if (isUnread(t) && !prev.has(t.id)) {
          if (next === prev) next = new Set(prev)
          next.add(t.id)
        }
      }
      return next
    })
  }, [view, listFocused, tasks])

  // Mark a task caught-up: advance its server-side `seenAt` to its latest
  // completed update, which clears its unseen dot. Optimistically advances the
  // local copy so the dot clears at once; the 2s poll reconciles. The server
  // stores the marker monotonically, so a stale/older value never moves it back.
  // Reads tasksRef so a delayed (dwell-timer) call sees the freshest data.
  async function markSeen(id: string) {
    const task = tasksRef.current.find((t) => t.id === id)
    if (!task) return
    const at = latestUpdateAt(task)
    if (!at || (task.seenAt && task.seenAt >= at)) return
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, seenAt: at } : t)),
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
  }

  // Mark a task unread: reset its server-side `seenAt` so the task's latest
  // update reads as unviewed again, re-showing its dot. Optimistically clears
  // the local marker so the dot appears at once; the 2s poll reconciles. The
  // next time the viewer reads the task, markSeen advances the marker forward
  // again.
  async function markUnread(id: string) {
    const task = tasksRef.current.find((t) => t.id === id)
    if (!task) return
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, seenAt: '' } : t)),
    )
    try {
      await fetch(`/api/${task.projectSlug}/tasks/${id}/unread`, {
        method: 'POST',
      })
    } catch {
      // best-effort; the next poll restores the true marker
    }
  }

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [retitling, setRetitling] = useState<string | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  const pathBySlug = new Map(projects.map((p) => [p.slug, p.path]))
  const allShown = projects.length > 0 && shown.length === projects.length
  // Tag each task row with its project's leaf only when more than one project's
  // tasks can be intermixed; with a single project shown it's just noise.
  const showProjectLabels = shown.length > 1

  // The update-time bound the time filter imposes, in ms (local time), or null
  // for 'any'. 'today'/'week' keep tasks at or after the start of today / this
  // week (Sunday); 'older' keeps tasks strictly before the start of this week.
  // Recomputed each render so it tracks the wall clock.
  const timeCutoff = (() => {
    if (timeFilter === 'any') return null
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    if (timeFilter === 'week' || timeFilter === 'older')
      start.setDate(now.getDate() - now.getDay())
    return { ms: start.getTime(), before: timeFilter === 'older' }
  })()

  // Filter by time window, then by title (case-insensitive), before grouping.
  const query = filter.trim().toLowerCase()
  const matchedTasks = tasks.filter((t) => {
    if (timeCutoff != null) {
      const ts = Date.parse(t.updatedAt ?? t.createdAt)
      if (!Number.isNaN(ts)) {
        if (timeCutoff.before ? ts >= timeCutoff.ms : ts < timeCutoff.ms)
          return false
      }
    }
    if (view === 'unread' && !isUnread(t) && !stickyUnread.has(t.id))
      return false
    return query ? t.title.toLowerCase().includes(query) : true
  })

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

  // Flatten orderedTasks into a list of rows interleaved with sticky headers:
  // a status header at every status change and, within a status whose tasks
  // span more than one date bucket, a date subheader at every bucket change.
  // Each task row keeps its orderedTasks index so the roving-tabindex refs and
  // keyboard navigation stay aligned with that array.
  const dayNow = new Date()
  const todayStart = new Date(
    dayNow.getFullYear(),
    dayNow.getMonth(),
    dayNow.getDate(),
  ).getTime()
  const weekStart = (() => {
    const s = new Date(todayStart)
    s.setDate(s.getDate() - s.getDay())
    return s.getTime()
  })()

  const dateCatsByStatus = new Map<string, Set<DateCategory>>()
  // Tasks per status+date bucket, keyed `${status}|${category}`, for the count a
  // date subheader's archive menu shows (and archives).
  const countByStatusDate = new Map<string, number>()
  for (const t of orderedTasks) {
    const cat = dateCategory(t.updatedAt ?? t.createdAt, todayStart, weekStart)
    const set = dateCatsByStatus.get(t.status) ?? new Set<DateCategory>()
    set.add(cat)
    dateCatsByStatus.set(t.status, set)
    const k = `${t.status}|${cat}`
    countByStatusDate.set(k, (countByStatusDate.get(k) ?? 0) + 1)
  }

  type TaskRow =
    | { kind: 'status'; key: string; status: string; first: boolean }
    | {
        kind: 'date'
        key: string
        category: DateCategory
        status: string
        first: boolean
      }
    | { kind: 'task'; key: string; task: TaskWithProject; index: number }

  const taskRows: TaskRow[] = []
  let rowStatus: string | null = null
  let rowCategory: DateCategory | null = null
  orderedTasks.forEach((task, index) => {
    if (task.status !== rowStatus) {
      taskRows.push({
        kind: 'status',
        key: `status-${task.status}`,
        status: task.status,
        // The first section gets no leading gap (nothing precedes it).
        first: rowStatus === null,
      })
      rowStatus = task.status
      rowCategory = null
    }
    const category = dateCategory(
      task.updatedAt ?? task.createdAt,
      todayStart,
      weekStart,
    )
    if (
      (dateCatsByStatus.get(task.status)?.size ?? 0) > 1 &&
      category !== rowCategory
    ) {
      taskRows.push({
        kind: 'date',
        key: `date-${task.status}-${category}`,
        category,
        status: task.status,
        // The first date in a status sits directly under the status header
        // (rowCategory is reset to null at each status change).
        first: rowCategory === null,
      })
      rowCategory = category
    }
    taskRows.push({ kind: 'task', key: task.id, task, index })
  })

  // Per-status counts for the summary row below the filter dropdown, ordered
  // left-to-right as the reverse of the list (landed, resting, riding, wedged
  // — STATUS_RANK descending). Only statuses present after filtering appear.
  const statusCounts = (() => {
    const counts = new Map<string, number>()
    for (const t of matchedTasks) {
      counts.set(t.status, (counts.get(t.status) ?? 0) + 1)
    }
    return [...counts.entries()].sort(
      (a, b) => (STATUS_RANK[b[0]] ?? 3) - (STATUS_RANK[a[0]] ?? 3),
    )
  })()
  const countByStatus = new Map(statusCounts)

  // The effective selection: the user's pick if it's still visible, otherwise
  // the first task in the list (e.g. after filtering hides the prior pick).
  const selected =
    selectedTaskId && tasks.some((t) => t.id === selectedTaskId)
      ? selectedTaskId
      : orderedTasks[0]?.id ?? null
  const current = tasks.find((t) => t.id === selected) ?? null

  // The open task's latest completed update, and whether the viewer is actively
  // viewing it (open + tab active + scrolled to the bottom where new content
  // lands). These drive the seen-marker advancement effect further below.
  const currentLatest = current ? latestUpdateAt(current) : ''
  const activelyViewing = !!current && tabActive && atBottom

  // The open task's conversation as a single stream: its messages in turn order,
  // merged with its lifecycle events by timestamp. The ordering rules (turn
  // grouping, read-time anchoring, queued sinking, event splicing) all live in
  // buildTimeline; `queuedIndices` rides back out so the render can dim the
  // follow-ups the agent hasn't read yet. `now` anchors any in-flight turn.
  const { items: timeline, queuedIndices } = current
    ? buildTimeline(current, new Date().toISOString())
    : {
        items: [] as TimelineItem<Message, TaskEvent>[],
        queuedIndices: new Set<number>(),
      }

  // Roving-tabindex bookkeeping for the task list: the selected row is the one
  // reachable with Tab, and arrow keys move DOM focus between rows.
  const taskItemRefs = useRef<(HTMLLIElement | null)[]>([])
  const taskListRef = useRef<HTMLUListElement>(null)
  // A zero-height, non-sticky anchor sits just before each status header, keyed
  // by status, so the count chips can scroll its section to the top. We can't
  // measure the header itself: the headers all share top:0, so a header you've
  // scrolled past stays pinned at the top and reports its pinned position, not
  // where its section begins. The static anchor always reports its true layout
  // position, so the rect delta to the list top is correct scrolling either way.
  const sectionAnchorRefs = useRef<Map<string, HTMLLIElement>>(new Map())
  function scrollToStatus(status: string) {
    const anchor = sectionAnchorRefs.current.get(status)
    const list = taskListRef.current
    if (!anchor || !list) return
    const delta =
      anchor.getBoundingClientRect().top - list.getBoundingClientRect().top
    list.scrollTo({ top: list.scrollTop + delta, behavior: 'smooth' })
  }
  const selectedIndex = orderedTasks.findIndex((t) => t.id === selected)
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : 0

  function selectTask(id: string, projectSlug: string) {
    setSelectedTaskId(id)
    window.history.pushState(null, '', `/${projectSlug}/${id}`)
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
        selectTask(task.id, task.projectSlug)
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
      // Picking a specific project also targets new tasks at it. Showing all
      // projects or changing the time/status filter leaves this untouched.
      setNewProject(slug)
    }
    setMenuOpen(false)
  }

  function showAll() {
    setShown(projects.map((p) => p.slug))
    setMenuOpen(false)
  }

  // Fetch and merge tasks across every shown project, tagging each with its
  // project slug and sorting the combined list by recency.
  async function loadShownTasks(
    slugs: string[],
    includeArchived: boolean = view === 'archived',
  ): Promise<{ tasks: TaskWithProject[]; usage: Usage | null }> {
    const lists = await Promise.all(
      slugs.map(async (slug) => {
        const r = await fetch(
          `/api/${slug}/tasks${includeArchived ? '?archived=1' : ''}`,
        )
        const body = await r.json()
        if (!r.ok) throw new Error(body.error ?? r.statusText)
        return {
          tasks: (body.tasks as Task[]).map((t) => ({ ...t, projectSlug: slug })),
          usage: (body.usage ?? null) as Usage | null,
        }
      }),
    )
    const merged = lists.flatMap((l) => l.tasks)
    merged.sort((a, b) =>
      (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
    )
    // Usage is global — every project's response carries the same snapshot, so
    // take the first one that's populated.
    const usage = lists.map((l) => l.usage).find((u) => u != null) ?? null
    return { tasks: merged, usage }
  }

  // Load the project list once. Reconcile the session-restored project filter
  // against it — keeping the picked slugs that still exist, and falling back to
  // "show all" only when nothing valid was restored (first visit, or every
  // picked project has since gone away). (A task named in the URL is seeded as
  // the selection by selectedTaskId's initializer.)
  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((list: Project[]) => {
        setProjects(list)
        const all = list.map((p) => p.slug)
        setShown((prev) => {
          const valid = prev.filter((s) => all.includes(s))
          return valid.length > 0 ? valid : all
        })
      })
      .catch(() => {})
  }, [])

  // Keep the selection in sync when navigating with the browser back/forward
  // buttons.
  useEffect(() => {
    const onPop = () => setSelectedTaskId(taskIdFromPath() || null)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Mirror the effective selection into the URL as /<project>/<id>. Held
  // off until tasks have loaded so a deep-linked task isn't clobbered before
  // its project's tasks arrive. replaceState (not push) corrects the URL in
  // place without adding spurious history entries.
  const hasLoadedRef = useRef(false)
  useEffect(() => {
    if (!hasLoadedRef.current) return
    const cur = tasks.find((t) => t.id === selected)
    const desired = cur ? `/${cur.projectSlug}/${cur.id}` : '/'
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
      loadShownTasks(shown, view === 'archived')
        .then(({ tasks, usage }) => {
          if (!cancelled) {
            setTasks(tasks)
            setUsage(usage)
            hasLoadedRef.current = true
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e.message ?? String(e))
        })
    refresh()
    // Poll so assistant replies appear once the server appends them.
    const timer = setInterval(refresh, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey, view])

  // Maintain the union of active and archived tasks for link resolution,
  // independent of the current view. Archived state changes rarely, so this
  // polls less often than the displayed list.
  useEffect(() => {
    if (shown.length === 0) return
    let cancelled = false
    const refresh = () =>
      Promise.all([loadShownTasks(shown, false), loadShownTasks(shown, true)])
        .then(([active, archived]) => {
          if (!cancelled) setLinkTasks([...active.tasks, ...archived.tasks])
        })
        .catch(() => {})
    refresh()
    const timer = setInterval(refresh, 10000)
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

  // Resolve a bare task id or an unambiguous prefix found in a message to an
  // internal link to that task, used to turn such references into clickable
  // links with the task's title as the text. A full-length id (>= 36 chars) is
  // matched exactly; anything shorter matches by prefix, and links only when it
  // uniquely identifies one loaded task (mirroring the CLI's unambiguous-prefix
  // rule). Returns undefined otherwise so the id renders as plain text. This is
  // purely presentational — the stored message and what's sent to the model are
  // untouched.
  const resolveTaskLink: TaskLinkResolver = (id) => {
    // A legacy/garbled reference can hand us an empty id (e.g. an old "awaiting"
    // event saved under the pre-rename shape); resolve it to no link rather than
    // throwing and taking down the whole task view.
    if (!id) return undefined
    const needle = id.toLowerCase()
    const matches =
      needle.length >= 36
        ? linkTasks.filter((t) => t.id?.toLowerCase() === needle)
        : linkTasks.filter((t) => t.id?.toLowerCase().startsWith(needle))
    if (matches.length !== 1) return undefined
    const t = matches[0]
    return {
      href: `/${t.projectSlug}/${t.id}`,
      title: t.title,
      status: t.status,
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
          agent: newTaskAgent,
          allowEdits: newAllowEdits,
          allowCommits: newAllowCommits,
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      const created = body as Task
      setTasks((await loadShownTasks(shown)).tasks)
      selectTask(created.id, targetSlug)
      setMessage('')
      // Edits default on for the next task; commits stay as the user left them.
      setNewAllowEdits(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  // Reset per-task view state when switching tasks so none of it bleeds across
  // them: leave title-edit mode, close any tool popup, and collapse revealed
  // tool details and expanded turns.
  useEffect(() => {
    setEditingTitle(false)
    setOpenTool(null)
    setOpenDetails(new Set())
    setExpandedTurns(new Set())
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
    const id = current.id
    const proj = current.projectSlug
    const next = titleDraft.trim()
    setEditingTitle(false)
    if (!next || next === current.title) return
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, title: next } : t)),
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
    if (!current || retitling === current.id) return
    const id = current.id
    const proj = current.projectSlug
    setRetitling(id)
    setError(null)
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}/retitle`, {
        method: 'POST',
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      const updated = body as Task
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, title: updated.title } : t)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRetitling((prev) => (prev === id ? null : prev))
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
  // assistant turn fills in. The trailing fields track the two agent-working
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
  // to the bottom), treat whatever's already there as a baseline and arm a 2s
  // dwell that marks it seen — so a glance that doesn't last doesn't clear the
  // dot. An update that arrives *while* actively viewing is past that baseline,
  // so it's marked seen at once.
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewTaskIdRef = useRef<string | null>(null)
  const viewBaselineRef = useRef<string>('')
  useEffect(() => {
    if (!activelyViewing || !current) {
      if (dwellTimerRef.current) {
        clearTimeout(dwellTimerRef.current)
        dwellTimerRef.current = null
      }
      viewTaskIdRef.current = null
      return
    }
    const id = current.id
    if (viewTaskIdRef.current !== id) {
      // Just began actively viewing this task: snapshot the baseline and arm the
      // dwell. Anything already present clears only once the 2s elapses.
      viewTaskIdRef.current = id
      viewBaselineRef.current = currentLatest
      if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current)
      dwellTimerRef.current = setTimeout(() => {
        dwellTimerRef.current = null
        void markSeen(id)
      }, 2000)
    } else if (currentLatest > viewBaselineRef.current) {
      // A new update landed while actively viewing — seen immediately.
      viewBaselineRef.current = currentLatest
      void markSeen(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activelyViewing, currentLatest, current?.id])

  async function sendReply() {
    if (!current) return
    const id = current.id
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
      setTasks((await loadShownTasks(shown)).tasks)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSendingBy((prev) => ({ ...prev, [id]: false }))
      // Disabling the textarea while sending drops its focus; restore it once
      // the element re-enables so you can keep typing the next reply.
      requestAnimationFrame(() => composerRef.current?.focus())
    }
  }

  // Retry a turn that wedged on an assistant error. The server decides between
  // nudging the session and re-sending the un-received prompt(s) from the
  // task's `retry` info; here we just fire it and refresh.
  async function retryTask() {
    if (!current) return
    const id = current.id
    const proj = current.projectSlug
    if (retryingBy[id]) return
    setRetryingBy((prev) => ({ ...prev, [id]: true }))
    setError(null)
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}/retry`, {
        method: 'POST',
        headers: uiHeaders(),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      setTasks((await loadShownTasks(shown)).tasks)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRetryingBy((prev) => ({ ...prev, [id]: false }))
    }
  }

  // Grant a blocked tool call from its popup: "task" scope persists the rule on
  // the task (used on future turns), "project" scope writes it to the project's
  // settings.local.json. Close the popup either way; refresh so a task-scoped
  // grant shows up.
  async function allowTool(rule: string, scope: 'task' | 'project') {
    if (!current) return
    const id = current.id
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
      if (typeof body.warning === 'string') setError(body.warning)
      if (scope === 'task') setTasks((await loadShownTasks(shown)).tasks)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function setAllowEdits(checked: boolean) {
    if (!current) return
    const id = current.id
    const proj = current.projectSlug
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, allowEdits: checked } : t)),
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
    const id = current.id
    const proj = current.projectSlug
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, allowCommits: checked } : t)),
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

  async function setStatus(task: TaskWithProject, status: string) {
    const id = task.id
    const proj = task.projectSlug
    setError(null)
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status } : t)),
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

  // Archive (or restore) a task by moving it between the project's tasks/ and
  // archived/ dirs. The list shows only active tasks or only archived ones, so
  // either action moves the row out of the current view: optimistically drop it
  // from the list. A reload reconciles.
  async function archiveTask(task: TaskWithProject, archived: boolean) {
    const id = task.id
    const proj = task.projectSlug
    setError(null)
    setTasks((prev) => prev.filter((t) => t.id !== id))
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}/archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived }),
      })
      if (!r.ok) {
        const body = await r.json()
        throw new Error(body.error ?? r.statusText)
      }
      setTasks((await loadShownTasks(shown)).tasks)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Archive every task in a section at once (the section header's kebab). A
  // section is a status, or — when the status is broken out into date buckets —
  // a single status+date bucket, so passing a category narrows the targets to
  // that date range. Drops them all optimistically, fires the per-task archive
  // calls in parallel, then reloads to reconcile — including any that failed,
  // which the reload brings back. Only offered for non-riding sections (a riding
  // task has a live run the server won't archive), so every target is archivable.
  async function archiveSection(status: string, category?: DateCategory) {
    const targets = orderedTasks.filter(
      (t) =>
        t.status === status &&
        (category == null ||
          dateCategory(t.updatedAt ?? t.createdAt, todayStart, weekStart) ===
            category),
    )
    if (targets.length === 0) return
    const ids = new Set(targets.map((t) => t.id))
    setError(null)
    setTasks((prev) => prev.filter((t) => !ids.has(t.id)))
    try {
      await Promise.all(
        targets.map(async (t) => {
          const r = await fetch(`/api/${t.projectSlug}/tasks/${t.id}/archive`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
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
    setTasks((await loadShownTasks(shown)).tasks)
  }

  // Launch a scheduled task now, ahead of its time (the header's "launch"
  // button). The server clears the schedule, records the launch, and starts the
  // agent; polling reconciles the new status.
  async function launchNow(task: TaskWithProject) {
    const id = task.id
    const proj = task.projectSlug
    setError(null)
    // Optimistic: drop the schedule and flip to riding so the button clears at
    // once and the launch button gives way to the resting one.
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status: 'riding', scheduledFor: undefined }
          : t,
      ),
    )
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
  // single shown project's leaf (just the last path segment — the menu items
  // still show full paths). The active time filter ("Today"/"This week", not
  // "Any time") and the non-default views ("Unread"/"Archived", not the "Inbox"
  // default) each append a "• …" suffix, in that order (e.g. "All projects •
  // Today • Unread").
  const filterBase =
    projects.length === 0
      ? ''
      : allShown && projects.length > 1
        ? 'All projects'
        : shown.length === 1
          ? lastPathComponent(pathBySlug.get(shown[0]) ?? shown[0])
          : `${shown.length} of ${projects.length}`
  const timeLabel =
    timeFilter === 'today'
      ? 'Today'
      : timeFilter === 'week'
        ? 'This week'
        : timeFilter === 'older'
          ? 'Older'
          : ''
  const viewLabel =
    view === 'unread' ? 'Unread' : view === 'archived' ? 'Archived' : ''
  // The base (project name) and the time/view suffixes are rendered as separate
  // spans so the name can carry heavier weight than the suffixes (see CSS).
  const filterSuffixes = [timeLabel, viewLabel].filter(Boolean)

  // Keep the page title in sync with the project-select label text.
  const filterLabel = [filterBase, ...filterSuffixes].filter(Boolean).join(' • ')
  useEffect(() => {
    document.title = filterLabel || 'lander'
  }, [filterLabel])

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
              <span className="project-select-label">
                {filterBase && (
                  <span className="project-select-name">{filterBase}</span>
                )}
                {filterSuffixes.map((s) => (
                  <span key={s} className="project-select-suffix">
                    {' • '}
                    {s}
                  </span>
                ))}
              </span>
              <svg
                className="project-select-caret"
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
              >
                <path
                  d="m6 9 6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
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
                  <span className="project-menu-path">All projects</span>
                </button>
                {(
                  [
                    ['today', 'Today'],
                    ['week', 'This week'],
                    ['older', 'Older'],
                    ['any', 'Any time'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className="project-menu-item project-menu-time"
                    role="menuitemradio"
                    aria-checked={timeFilter === value}
                    onClick={() => {
                      setTimeFilter(value)
                      setMenuOpen(false)
                    }}
                  >
                    <span className="project-menu-check">
                      {timeFilter === value ? '✓' : ''}
                    </span>
                    <span className="project-menu-path">{label}</span>
                  </button>
                ))}
                {(
                  [
                    ['inbox', 'Inbox'],
                    ['unread', 'Unread'],
                    ['archived', 'Archived'],
                  ] as const
                ).map(([value, label], i) => (
                  <button
                    key={value}
                    type="button"
                    className={
                      'project-menu-item project-menu-view' +
                      (i === 0 ? ' project-menu-view-first' : '')
                    }
                    role="menuitemradio"
                    aria-checked={view === value}
                    onClick={() => {
                      setView(value)
                      setMenuOpen(false)
                    }}
                  >
                    <span className="project-menu-check">
                      {view === value ? '✓' : ''}
                    </span>
                    <span className="project-menu-path">{label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="task-toolbar">
          {projects.length > 0 && statusCounts.length > 0 && (
            <div className="task-counts">
              {statusCounts.map(([status, count]) => (
                <button
                  key={status}
                  type="button"
                  className={'task-count ' + status}
                  onClick={() => scrollToStatus(status)}
                >
                  <span className="task-count-num">{count}</span> {status}
                </button>
              ))}
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
        </div>
        <ul
          ref={taskListRef}
          className="task-list"
          role="listbox"
          aria-label="Tasks"
          onFocus={() => setListFocused(true)}
          onBlur={(e) => {
            // focusout bubbles, so this fires when focus hops between rows too;
            // only count it as leaving when the new target is outside the list
            // (a text field, another pane, or — with a null target — the window).
            if (!e.currentTarget.contains(e.relatedTarget as Node | null))
              setListFocused(false)
          }}
        >
          {tasks.length === 0 && (
            <li className="empty" role="presentation">No tasks yet</li>
          )}
          {tasks.length > 0 && orderedTasks.length === 0 && (
            <li className="empty" role="presentation">No matching tasks</li>
          )}
          {taskRows.map((row, ri) => {
            // Faint rules bracket each contiguous run of task rows around the
            // headers. The header→tasks rule (rule-below) rides on the header so it
            // pins with it in sticky mode. The tasks→header rule rides in the flow
            // just above the header as its own <li>, so it scrolls up and out of
            // view as the header pins (no separator between stacked sticky headers)
            // and keeps clear of the header text below it.
            const prevIsTask = ri > 0 && taskRows[ri - 1].kind === 'task'
            const nextIsTask =
              ri < taskRows.length - 1 && taskRows[ri + 1].kind === 'task'
            if (row.kind === 'status') {
              return (
                <Fragment key={row.key}>
                  <li
                    ref={(el) => {
                      if (el) sectionAnchorRefs.current.set(row.status, el)
                      else sectionAnchorRefs.current.delete(row.status)
                    }}
                    className={
                      'task-section-anchor' + (row.first ? ' first' : '')
                    }
                    role="presentation"
                    aria-hidden="true"
                  />
                  {prevIsTask && (
                    <li
                      className="task-rule"
                      role="presentation"
                      aria-hidden="true"
                    />
                  )}
                  <li
                    role="presentation"
                    className={
                      'task-group-header status ' +
                      row.status +
                      (row.first ? ' first' : '') +
                      ((dateCatsByStatus.get(row.status)?.size ?? 0) > 1
                        ? ' split'
                        : '') +
                      (nextIsTask ? ' rule-below' : '')
                    }
                  >
                    <span className="task-group-label">{row.status}</span>
                    {/* The archive menu rides the leaf header: here only when the
                        status isn't broken out into dates (otherwise each date
                        subheader carries its own, below). A riding task has a live
                        run the server won't archive, so that section gets none;
                        the archived view is already the archive, so it gets none
                        either. */}
                    {view !== 'archived' &&
                      row.status !== 'riding' &&
                      (dateCatsByStatus.get(row.status)?.size ?? 0) <= 1 && (
                        <SectionActionsMenu
                          count={countByStatus.get(row.status) ?? 0}
                          onArchive={() => archiveSection(row.status)}
                        />
                      )}
                  </li>
                </Fragment>
              )
            }
            if (row.kind === 'date') {
              return (
                <Fragment key={row.key}>
                  {prevIsTask && (
                    <li
                      className="task-rule"
                      role="presentation"
                      aria-hidden="true"
                    />
                  )}
                  <li
                    role="presentation"
                    className={
                      'task-group-header date ' +
                      row.status +
                      (row.first ? ' first' : '') +
                      (nextIsTask ? ' rule-below' : '')
                    }
                  >
                    <span className="task-group-label">
                      {DATE_CATEGORY_LABELS[row.category]}
                    </span>
                    {/* The leaf header for a date-broken status: its menu
                        archives only this status+date bucket. Riding never breaks
                        out a menu (live runs); archived view shows none. */}
                    {view !== 'archived' && row.status !== 'riding' && (
                      <SectionActionsMenu
                        count={
                          countByStatusDate.get(
                            `${row.status}|${row.category}`,
                          ) ?? 0
                        }
                        onArchive={() =>
                          archiveSection(row.status, row.category)
                        }
                      />
                    )}
                  </li>
                </Fragment>
              )
            }
            const { task, index } = row
            const unseen = isUnread(task)
            // Any armed scheduled message — a deferred relaunch, a plain deferred
            // send (`lander send --date/--time/--await`), or a repeating relaunch —
            // shows the clock. Earlier this keyed only off relaunch-flagged
            // messages, so a plain deferred send (deliverAt/waitFor, no relaunch
            // flag) armed no indicator at all.
            const pendingScheduled = task.scheduledMessages?.[0]
            return (
            <li
              key={row.key}
              ref={(el) => {
                taskItemRefs.current[index] = el
              }}
              role="option"
              aria-selected={task.id === selected}
              tabIndex={index === rovingIndex ? 0 : -1}
              className={
                'task-item' +
                (task.id === selected ? ' selected' : '') +
                ' ' +
                task.status +
                (task.archived ? ' archived' : '') +
                (unseen ? ' unread' : '')
              }
              onClick={() => selectTask(task.id, task.projectSlug)}
              onKeyDown={(e) => onTaskKeyDown(e, index, task)}
            >
              <div className="task-item-main">
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
                {task.archived && (
                  <div className="task-meta-row">
                    <span className="task-archived-tag">archived</span>
                  </div>
                )}
                <div className="task-time">
                  {formatTaskTime(task.updatedAt ?? task.createdAt, todayStart)}
                  {(task.scheduledFor ||
                    (task.waitingFor && task.waitingFor.length > 0) ||
                    pendingScheduled) && (
                    <svg
                      className="scheduled-clock"
                      width="11"
                      height="11"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-label={
                        task.scheduledFor || pendingScheduled?.deliverAt
                          ? 'Scheduled'
                          : 'Awaiting'
                      }
                    >
                      <circle cx="8" cy="8" r="6" />
                      <path d="M8 4.5V8l2.5 1.5" />
                    </svg>
                  )}
                  {task.scheduledMessages?.some((m) => m.repeat) && (
                    <svg
                      className="repeat-arrow"
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-label="Repeats"
                    >
                      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                      <path d="M21 3v5h-5" />
                    </svg>
                  )}
                  {task.status === 'riding' && (
                    <span className="riding-spinner" aria-label="Riding" />
                  )}
                </div>
              </div>
              <TaskActionsMenu
                task={task}
                onAction={(action) => {
                  if (action === 'launch') void launchNow(task)
                  else if (action === 'wedge') void setStatus(task, 'wedged')
                  else if (action === 'rest') void setStatus(task, 'resting')
                  else if (action === 'land') void setStatus(task, 'landed')
                  else if (action === 'copyId')
                    void navigator.clipboard.writeText(task.id).catch(() => {})
                  else if (action === 'markUnread') void markUnread(task.id)
                  else if (action === 'archive') void archiveTask(task, true)
                  else if (action === 'restore') void archiveTask(task, false)
                }}
              />
            </li>
            )
          })}
        </ul>

        <form className="new-task" onSubmit={onSubmit}>
          <div className="new-task-head">
            <h2>New task</h2>
            <select
              className="new-task-agent"
              value={newTaskAgent}
              onChange={(e) => setNewTaskAgent(e.target.value as Task['agent'])}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
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

        <UsageSummary usage={usage} agent={current?.agent} />
      </div>

      <div className="detail">
        {error && <div className="error">{error}</div>}
        {current ? (
          <>
            <div className="detail-header">
              {(projects.length > 1 || worktreeName(current.cwd)) && (
                <div className="detail-project">
                  {lastPathComponent(
                    pathBySlug.get(current.projectSlug) ??
                      current.projectSlug,
                  )}
                  {worktreeName(current.cwd) &&
                    ` • ${worktreeName(current.cwd)}`}
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
                  <h1
                    className="editable-title"
                    title="Click to edit title"
                    onClick={startTitleEdit}
                  >
                    {current.title}
                  </h1>
                  <button
                    className="edit-title-button"
                    title="Regenerate title"
                    aria-label="Regenerate title"
                    disabled={retitling === current.id}
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
                  <CopyIdButton id={current.id} />
                  <TaskActionsMenu
                    task={current}
                    onAction={(action) => {
                      if (action === 'launch') void launchNow(current)
                      else if (action === 'wedge')
                        void setStatus(current, 'wedged')
                      else if (action === 'rest')
                        void setStatus(current, 'resting')
                      else if (action === 'land')
                        void setStatus(current, 'landed')
                      else if (action === 'copyId')
                        void navigator.clipboard
                          .writeText(current.id)
                          .catch(() => {})
                      else if (action === 'markUnread')
                        void markUnread(current.id)
                      else if (action === 'archive')
                        void archiveTask(current, true)
                      else if (action === 'restore')
                        void archiveTask(current, false)
                    }}
                  />
                </div>
              )}
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
                      slug={current.projectSlug}
                      linkTask={resolveTaskLink}
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
                  </div>
                  {/* Streamed assistant turns render their live activity trace;
                      user and legacy messages just render their text. */}
                  {m.steps && m.steps.length > 0 ? (
                    <div className="steps">
                      {(() => {
                        // Map each tool call's id to its result outcome so a
                        // tool_use chip can show whether it was allowed/blocked,
                        // and fold the result's text/error in so the chip can
                        // reveal it as collapsible detail.
                        const outcomes = new Map<string, boolean>()
                        const resultById = new Map<
                          string,
                          { text?: string; isError?: boolean }
                        >()
                        const hasToolUse = new Set<string>()
                        // A subagent's steps (tagged with their spawning call's id)
                        // don't render inline — they fold into that call's chip. Map
                        // each spawning id to its direct children's step indices so
                        // renderStep can nest them; the links go arbitrarily deep, so
                        // rendering a child recurses on its own children in turn.
                        const childrenByParent = new Map<string, number[]>()
                        m.steps.forEach((s, j) => {
                          if (s.kind === 'tool_result' && s.toolUseId) {
                            outcomes.set(s.toolUseId, !!s.blocked)
                            resultById.set(s.toolUseId, {
                              text: s.text,
                              isError: s.isError,
                            })
                          }
                          if (s.kind === 'tool_use' && s.toolUseId)
                            hasToolUse.add(s.toolUseId)
                          if (s.parentToolUseId) {
                            const sibs = childrenByParent.get(s.parentToolUseId)
                            if (sibs) sibs.push(j)
                            else childrenByParent.set(s.parentToolUseId, [j])
                          }
                        })
                        // Keys of every chip with revealable detail (a diff, a
                        // result with text, or a nested subagent trace) in this
                        // message, so an option/shift-click on one toggles them all
                        // together — nested chips included, since their keys index
                        // the same flat step array.
                        const detailKeys = m.steps!
                          .map((s, j) =>
                            s.kind === 'tool_use' &&
                            (s.edits?.length ||
                              (s.toolUseId &&
                                (resultById.get(s.toolUseId)?.text ||
                                  childrenByParent.has(s.toolUseId))))
                              ? `${i}:${j}`
                              : null,
                          )
                          .filter((k): k is string => k !== null)
                        // Group consecutive step indices by the model inference
                        // that produced them: a text/tool_use step whose
                        // inferenceId differs from the last one seen opens a new
                        // group. Only those steps carry an id, so a turn's
                        // interleaved tool_results stay with the current group. Each
                        // group is one inference — ruled apart from the next. Serves
                        // both the main trace and, recursively, each subagent's own
                        // (see renderSubSteps).
                        const groupByInference = (idxs: number[]): number[][] => {
                          const gs: number[][] = []
                          let last: string | undefined
                          for (const j of idxs) {
                            const s = m.steps![j]
                            if (
                              gs.length === 0 ||
                              (s.inferenceId &&
                                last !== undefined &&
                                s.inferenceId !== last)
                            )
                              gs.push([])
                            gs[gs.length - 1].push(j)
                            if (s.inferenceId) last = s.inferenceId
                          }
                          return gs
                        }
                        // The main trace omits subagent steps entirely — they're
                        // folded under their spawning chip — so their inference ids
                        // never open a main-trace group nor feed collapse/copy
                        // controls.
                        const mainIdxs = m.steps
                          .map((_, j) => j)
                          .filter((j) => !m.steps![j].parentToolUseId)
                        const renderStep = (j: number) => {
                          const s = m.steps![j]
                          const key = `${i}:${j}`
                          // The chip's result (if it has landed) and whether the
                          // call is in the turn's permission_denials.
                          const res =
                            s.kind === 'tool_use' && s.toolUseId
                              ? resultById.get(s.toolUseId)
                              : undefined
                          const inDenials =
                            s.kind === 'tool_use' && s.toolUseId
                              ? outcomes.get(s.toolUseId) === true
                              : false
                          // permission_denials lands with the turn's terminal
                          // result event, after which the message stops being
                          // pending. Until then we can't tell a refusal from a
                          // plain error, so treat the denials as not-yet-known.
                          const denialsKnown = !m.pending
                          const status: ToolStatus =
                            s.kind !== 'tool_use'
                              ? 'running'
                              : inDenials
                                ? 'blocked'
                                : res?.isError
                                  ? 'failed'
                                  : res
                                    ? 'ok'
                                    : 'running'
                          // Offer the grant when the call was refused, or it
                          // errored before the denials list arrived (it might yet
                          // prove a refusal). Once the list is known and this call
                          // isn't in it, the error was a genuine failure — no grant.
                          const allowable =
                            s.kind === 'tool_use' &&
                            (inDenials || (!!res?.isError && !denialsKnown))
                          // A result owned by a tool_use chip is now revealed from
                          // that chip — skip the standalone peek. Orphan/legacy
                          // results (no matching chip) still render inline.
                          if (
                            s.kind === 'tool_result' &&
                            s.toolUseId &&
                            hasToolUse.has(s.toolUseId)
                          )
                            return null
                          // A subagent spawner (Agent/Explore) carries its
                          // subagent's steps as children; render them as the chip's
                          // nested trace. renderStep recurses, so a sub-subagent's
                          // own chips nest in turn.
                          const childIdxs =
                            s.kind === 'tool_use' && s.toolUseId
                              ? childrenByParent.get(s.toolUseId)
                              : undefined
                          const subSteps = childIdxs?.length
                            ? renderSubSteps(childIdxs)
                            : undefined
                          return (
                            <Step
                              key={j}
                              step={s}
                              status={status}
                              allowable={allowable}
                              result={res}
                              open={openTool === key}
                              onToggle={() =>
                                setOpenTool(openTool === key ? null : key)
                              }
                              onClose={() => setOpenTool(null)}
                              onAllow={allowTool}
                              detailOpen={openDetails.has(key)}
                              onToggleDetail={(all) =>
                                toggleDetail(key, all ? detailKeys : [key])
                              }
                              agent={current.agent}
                              linkTask={resolveTaskLink}
                              subSteps={subSteps}
                            />
                          )
                        }
                        const renderStepList = (
                          idxs: number[],
                          initialSep = false,
                          keyPrefix = 'steps',
                        ) =>
                          groupByInference(idxs).map((groupIdxs, k) => (
                            <Fragment
                              key={`${keyPrefix}-${k}-${groupIdxs[0] ?? 'empty'}`}
                            >
                              {(initialSep || k > 0) && (
                                <hr className="turn-sep" />
                              )}
                              <div className="inference">
                                {groupIdxs.map(renderStep)}
                              </div>
                            </Fragment>
                          ))
                        // A subagent's folded trace, grouped into its own turns the
                        // same way the main trace is — ruled apart by a turn-sep so
                        // its inferences read as distinct turns. Mutually recursive
                        // with renderStep (a nested subagent nests in turn).
                        const renderSubSteps = (childIdxs: number[]) =>
                          renderStepList(
                            childIdxs,
                            false,
                            `sub-${childIdxs[0] ?? 'empty'}`,
                          )
                        // Assistant turns fold down by assistant text messages,
                        // independent of inference boundaries: keep an opening text
                        // message only when it comes before tool calls, keep the
                        // longest text message and everything after it, and collapse
                        // the flat step range between them. A turn still being
                        // written renders in full (its shape isn't settled yet), as
                        // does any turn too short to have a gap.
                        const collapse = planTurnCollapse(m.steps!, mainIdxs)
                        const folds =
                          m.role === 'assistant' &&
                          !m.pending &&
                          collapse.hidden.length > 0
                        if (!folds) return renderStepList(mainIdxs)
                        const toolCount = collapse.hidden
                          .filter((j) => m.steps![j].kind === 'tool_use').length
                        const open = expandedTurns.has(i)
                        return (
                          <>
                            {collapse.visibleBefore.length > 0 &&
                              renderStepList(
                                collapse.visibleBefore,
                                false,
                                'before',
                              )}
                            {collapse.visibleBefore.length > 0 && (
                              <hr className="turn-sep" />
                            )}
                            <Collapsible
                              open={open}
                              onToggle={() => toggleTurn(i)}
                              label={
                                <span className="collapsible-label">
                                  {collapse.hidden.length} step
                                  {collapse.hidden.length === 1 ? '' : 's'}
                                  {toolCount > 0 &&
                                    `, ${toolCount} tool${
                                      toolCount === 1 ? '' : 's'
                                    }`}
                                  …
                                </span>
                              }
                            >
                              {renderStepList(
                                collapse.hidden,
                                false,
                                'hidden',
                              )}
                            </Collapsible>
                            {renderStepList(
                              collapse.visibleAfter,
                              true,
                              'after',
                            )}
                          </>
                        )
                      })()}
                    </div>
                  ) : (
                    <MessageText text={m.text} linkTask={resolveTaskLink} />
                  )}
                  {m.pending && (
                    <div className="message-pending">
                      <span className="spinner" aria-hidden />
                      {`${taskAgentModelName(current.agent, m.usage?.model)} is working…`}
                    </div>
                  )}
                </div>
                )
              })}
              {/* No assistant message yet but the task is riding: the assistant
                  has been launched and we're waiting for its first output. The
                  turn's model isn't known until that output arrives, so this
                  stays model-agnostic rather than guessing the prior turn's. */}
              {current.status === 'riding' &&
                current.messages[current.messages.length - 1]?.role ===
                  'user' && (
                  <div className="message">
                    <div className="message-pending">
                      <span className="spinner" aria-hidden />
                      {`${taskAgentModelName(current.agent)} is starting…`}
                    </div>
                  </div>
                )}
              {current.status === 'wedged' && current.retry && (
                <div className="retry-bar">
                  <button
                    type="button"
                    className="retry-button"
                    disabled={retryingBy[current.id] ?? false}
                    onClick={() => void retryTask()}
                    title={
                      retryResetTime(current.retry)
                        ? `You've hit the session limit — schedule the retry for when it resets (${retryResetTime(current.retry)})`
                        : current.retry.committed
                          ? 'Nudge the session to pick the turn back up (re-sending would duplicate it)'
                          : 'Re-send your message — it never reached the session'
                    }
                  >
                    {retryResetTime(current.retry)
                      ? `Retry at ${retryResetTime(current.retry)}`
                      : current.retry.committed
                        ? 'Try again'
                        : 'Resend'}
                  </button>
                </div>
              )}
            </div>
            <div className="composer-bar">
              <textarea
                ref={composerRef}
                className="composer"
                placeholder={
                  current.archived ? 'Restore this task to reply' : 'Reply…'
                }
                rows={3}
                value={replies[current.id] ?? ''}
                disabled={
                  (sendingBy[current.id] ?? false) || !!current.archived
                }
                onChange={(e) =>
                  setReplies((prev) => ({
                    ...prev,
                    [current.id]: e.target.value,
                  }))
                }
                onKeyDown={onReplyKeyDown}
              />
              <div className="allow-row">
                <label className="allow-edits">
                  <input
                    type="checkbox"
                    checked={current.allowEdits}
                    disabled={!!current.archived}
                    onChange={(e) => void setAllowEdits(e.target.checked)}
                  />
                  allow edits
                </label>
                <label className="allow-edits">
                  <input
                    type="checkbox"
                    checked={current.allowCommits}
                    disabled={!!current.archived}
                    onChange={(e) => void setAllowCommits(e.target.checked)}
                  />
                  allow commits
                </label>
                {(() => {
                  const u = usageTotal
                    ? totalUsage(current)
                    : latestUsage(current)
                  if (!u) return null
                  // Uncached = fresh input processed this turn (regular input +
                  // the part written to cache); cache read is the discounted
                  // re-read of cached context — reported separately.
                  const uncached = u.input + u.cacheCreation
                  const scope = usageTotal ? 'total' : 'turn'
                  const costText =
                    u.costUsd !== undefined
                      ? `$${u.costUsd.toFixed(4)}`
                      : current.agent === 'codex'
                        ? 'unavailable for Codex'
                        : '… (available when the turn lands)'
                  const costBadge =
                    u.costUsd !== undefined
                      ? formatCost(u.costUsd)
                      : current.agent === 'codex'
                        ? 'n/a'
                        : '$…'
                  return (
                    <div className="token-usage">
                      <span className="token-model">
                        {taskAgentModelName(current.agent, u.model)}
                      </span>
                      <button
                        type="button"
                        className="token-stats"
                        onClick={() => setUsageTotal((v) => !v)}
                        title={
                          `${scope} — click to show ` +
                          `${usageTotal ? 'turn' : 'total'}\n` +
                          `uncached input ${u.input.toLocaleString()} ` +
                          `(+ ${u.cacheCreation.toLocaleString()} written to cache)\n` +
                          `cache read ${u.cacheRead.toLocaleString()}\n` +
                          // The turn's cache-miss diagnostic, when the API
                          // reported one (per-turn only; misses don't sum).
                          (!usageTotal && u.cacheMiss
                            ? `cache miss: ${u.cacheMiss.reason.replaceAll('_', ' ')} ` +
                              `(${u.cacheMiss.missedTokens.toLocaleString()} tokens missed)\n`
                            : '') +
                          `output ${u.output.toLocaleString()}\n` +
                          `cost ${costText}`
                        }
                      >
                        <span className="token-scope">{scope}</span>
                        <span>in {formatTokens(uncached)}</span>
                        <span>cache {formatTokens(u.cacheRead)}</span>
                        <span>out {formatTokens(u.output)}</span>
                        {/* Claude cost arrives with the turn's result event; Codex
                            currently reports token usage without account cost. */}
                        <span className="token-cost">{costBadge}</span>
                      </button>
                    </div>
                  )
                })()}
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
