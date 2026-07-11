// Token counts a turn consumed, accumulated as it streams and finalized by its
// result event. `input` and `cacheCreation` are fresh input processed this turn
// (uncached); `cacheRead` is the discounted re-read of cached context. `model`
// is the session's driving (main-agent) model. `costUsd` is the turn's dollar
// cost, present only once the turn lands. Shown in the composer's corner — latest
// turn, or summed across the task — updating live as the turn runs.
export type TokenUsage = {
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

export type Attachment = { id: string; name: string; mime: string; size: number }
export type Artifact = {
  name: string
  id: string
  mime: string
  size: number
  createdAt: string
  updatedAt: string
}

// The lifecycle event kinds carried by an event item (see EventItem): the task's
// launch, a rename, a schedule/await, a `relaunch` divider, or a crossing into/
// out of the wedged (needs the user) or terminal landed state.
export type EventKind =
  | 'launched'
  | 'scheduled'
  | 'awaiting'
  | 'wedged'
  | 'unwedged'
  | 'landed'
  | 'unlanded'
  | 'renamed'
  | 'relaunched'

// One option in a choice ask. `at` schedules the answer's delivery for that time
// (e.g. "retry when the limit resets"); `value` + `editable` prefill a text the
// user can amend before answering (e.g. a permission rule).
export type AskOption = {
  id: string
  label: string
  detail?: string
  style?: 'primary' | 'danger'
  at?: string
  value?: string
  editable?: boolean
}

// Only the choice form ships (confirm/free-text were dropped as producerless —
// see server/asks.ts). A one-variant discriminated shape, so a future variant is
// a non-breaking addition and stored asks keep their `type` tag.
export type AskForm = { type: 'choice'; options: AskOption[] }

// A stored question raised on a task. A task-blocking ask is what a wedged task
// is waiting on: the reason is the prompt, the buttons are the options. Mirrors
// the server's Ask; the client carries it as an AskItem in the item log.
export type Ask = {
  id: string
  createdAt: string
  // Optional markdown above the form. An agent wedge omits it (its own message is
  // the question); platform asks (the retry ask) carry their own.
  prompt?: string
  form: AskForm
  blocking: 'ride' | 'task' | 'none'
  state: 'open' | 'answered' | 'withdrawn'
  answer?: { optionId?: string; text?: string; at: string }
  // Marks the platform usage-limit/error retry ask; the UI answers it through
  // the same endpoint, and the server routes it through retry recovery.
  origin?: 'retry'
}

// A ride: one activation of the task's flow (today an agent turn, mapped 1:1
// onto the daemon run whose runId it borrows). Mirrors the server's Ride. An
// absent `endedAt` marks an open ride — the task is actively riding, and the
// spinner renders after its last item. A closed ride carries an `outcome` and
// the turn's `usage`.
export type Ride = {
  id: string
  startedAt: string
  endedAt?: string
  outcome?: 'done' | 'interrupted' | 'error'
  usage?: TokenUsage
}

// One entry in the unified item log that replaces the parallel messages/events/
// asks arrays (see docs/conversation-model.md). A discriminated union on `kind`
// mirroring the server's Item; the common fields sit on every kind.
type ItemCommon = {
  // Stable id: tool items reuse the provider toolUseId, ask items keep their
  // `ask-…` id, message/event items mint `itm-…`.
  id: string
  at: string
  // Absent for out-of-ride items (user messages, most events); present on every
  // item a ride produced (flow messages, tools).
  rideId?: string
  // Nesting: a subagent's items point at the spawning tool item; a natively-
  // written ask points at its raising message item. Generalizes parentToolUseId.
  parentId?: string
  // Grouping key (renamed from inferenceId): items emitted in one atomic burst.
  // Not 1:1 with items — one inference fans out into a text block plus a parallel
  // tool batch. A change between consecutive items rules a collapse line.
  groupId?: string
}

export type MessageItem = ItemCommon & {
  kind: 'message'
  role: 'user' | 'flow'
  text: string
  attachments?: Attachment[]
  artifacts?: Artifact[]
  // Set on a user message once a queued batch delivers it: the ride that
  // consumed it. Absent on converted history.
  deliveredIn?: string
  // Client-facing only: set by publicTask on a trailing user item the agent
  // hasn't read yet (the item analog of the old Message.queued). We dim it and
  // sink it in the timeline.
  queued?: boolean
}

export type ToolItem = ItemCommon & {
  kind: 'tool'
  name: string
  input: string
  // The untruncated, newline-preserving input revealed under the chip's
  // disclosure; absent for short inputs and older items.
  inputFull?: string
  // The call as a settings.json permission rule, e.g. `Bash(ls)`.
  rule?: string
  // Folded in from the tool_result: the result peek and the call's outcome.
  // `running` until the result lands.
  output?: string
  status: 'running' | 'ok' | 'failed' | 'blocked'
  // For the file-writing tools (Edit/Write/MultiEdit): the change as before/
  // after hunks, revealed as a diff under the chip's disclosure.
  edits?: { old: string; new: string }[]
}

export type EventItem = ItemCommon & {
  kind: 'event'
  // The lifecycle verb, renamed from `kind` to avoid clashing with the item's own.
  eventKind: EventKind
  title?: string
  scheduledFor?: string
  awaiting?: { id: string; title: string }[]
}

export type AskItem = ItemCommon & {
  kind: 'ask'
  // Today's Ask payload minus `createdAt` (the item's `at` carries it).
  prompt?: string
  form: AskForm
  blocking: Ask['blocking']
  state: Ask['state']
  answer?: NonNullable<Ask['answer']>
  origin?: 'retry'
}

export type Item = MessageItem | ToolItem | EventItem | AskItem

export type Task = {
  // The task's own short id (a nanoid; legacy tasks carry the uuid they were
  // keyed by). Distinct from the provider session that backs its turns, which
  // the daemon owns and the client never sees.
  id: string
  agent: 'claude' | 'codex'
  // Grant-capability flags derived server-side (publicTask/agentGrantCaps): `task`
  // = task-scope allow rules are honored, `project` = project grants are supported.
  // The grant UI reads these instead of branching on `agent`, so a provider that
  // doesn't honor a scope degrades from data. Absent on legacy payloads — treat as
  // fully capable.
  grants?: { task: boolean; project: boolean }
  // Whether this task's agent reports a per-turn dollar cost (derived server-side
  // by publicTask/agentReportsCost: claude does, codex doesn't). The footer reads
  // this instead of branching on `agent`, so a provider without cost degrades from
  // data. Absent on legacy payloads / fixtures without an agent.
  reportsCost?: boolean
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
  // The unified item log and its ride headers — the shape the UI renders.
  // `items` is one flat ordered log (message/tool/event/ask), `rides` the turn
  // headers keyed by id. Absent only on a task with no activity yet; the server
  // converts legacy records to this shape on read.
  items?: Item[]
  rides?: Ride[]
  // The working directory the previous turn ended in, recorded by the Stop hook
  // (see the server's Task.cwd). When it's a git worktree the agent entered, its
  // name shows beside the project in the detail header. Absent until the first
  // turn completes, or when the task never left the project root.
  cwd?: string
}

// A task tagged with the slug of the project it came from, so the merged
// cross-project list knows which project's API to hit for each task.
export type TaskWithProject = Task & { projectSlug: string }

export type Project = {
  path: string
  slug: string
}

// A presentation-agnostic telemetry datum a flow publishes for one of the two
// readouts (the per-flow status panel below the new-task form; the per-task
// composer footer). The server caches and serves these opaquely and the UI renders
// them blind — the producing flow owns what they mean. Three shapes:
//   text  — a labeled string ("Model: claude-sonnet-5")
//   count — a labeled number, shown abbreviated ("Tokens: 12k")
//   meter — a bar: value/max as a percentage, an optional accent band ('warn'), and
//           an optional preformatted note (e.g. "resets 3:45 PM"). The producer, not
//           the renderer, decides the band and formats the note.
export type TelemetryItem =
  | { id: string; label: string; type: 'text'; value: string }
  | { id: string; label: string; type: 'count'; value: number; unit?: string }
  | {
      id: string
      label: string
      type: 'meter'
      value: number
      max: number
      level?: 'ok' | 'warn'
      note?: string
    }

// The list's time window: tasks updated today, this week (from Sunday), before
// this week ('older', same Sunday cutoff), or with no bound. 'today'/'week'/
// 'older' also surface in the dropdown title.
export type TimeFilter = 'today' | 'week' | 'older' | 'any'
// Which slice of tasks the list shows: 'inbox' (everything not archived, the
// default), 'unread' (just the inbox tasks with unviewed updates), or
// 'archived'. Mutually exclusive, chosen from the project filter dropdown.
export type TaskView = 'inbox' | 'unread' | 'archived'

export type DateCategory = 'today' | 'week' | 'older'
