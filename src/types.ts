import type { ContextAction, ContextDetails } from '../shared/context'

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

// The lifecycle event kinds carried by an event item (see EventItem): the task's
// launch, a rename, a schedule/await, a `relaunch` divider, lander notifying the
// task why it woke, or a crossing into/
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
  | 'notified'

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
  // Listed in a menu beside the buttons (see server/asks.ts).
  menu?: true
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
  compacting?: true
  // See the server's Ride.
  waiting?: true
  id: string
  startedAt: string
  // The flow this turn was for; see the server's Ride.
  flow?: string
  endedAt?: string
  outcome?: 'done' | 'interrupted' | 'error'
  usage?: TokenUsage
  // How long the run worked, as the daemon measured it — not `endedAt` minus
  // `startedAt`, which also counts hand-off, a watchdog kill's idle window, and
  // any server downtime a boot-recovery close absorbed. Absent on a ride whose
  // run never reported a done; such a turn shows no time, the way a turn without
  // a result event shows no cost.
  durationMs?: number
  // Present only on an 'error' outcome: the failure's diagnostics (exit code,
  // the daemon's cause for a synthesized done, the stderr tail).
  error?: { exitCode?: number; cause?: string; idleMs?: number; stderr?: string }
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
  // item a ride produced (flow messages, tools, agent-raised asks).
  rideId?: string
  // Nesting: a subagent's items point at the spawning tool item. Generalizes
  // parentToolUseId.
  parentId?: string
  // Grouping key (renamed from inferenceId): items emitted in one atomic burst.
  // Not 1:1 with items — one inference fans out into a text block plus a parallel
  // tool batch. A change between consecutive items rules a collapse line.
  groupId?: string
}

export type MessageItem = ItemCommon & {
  kind: 'message'
  // `hook` is a task hook's nudge — a finding it appended and drove as a turn.
  // Rendered as its own voice: not the user, who did not say it, and not the
  // flow, which would make it look like the task's own output.
  role: 'user' | 'flow' | 'hook'
  text: string
  // Who spoke, when it was not the task's human: the hook on a `hook` message,
  // or on a `user` message the task that launched, messaged, or `--await`-woke
  // this one — or this task itself, briefing its next session in a relaunch —
  // or lander, notifying the task why it woke.
  from?:
    | { hook: string; path: string; fireId: string }
    | { task: string; via: 'launch' | 'send' | 'notify' | 'relaunch' }
    | { lander: 'time' | 'await' | 'restart' }
  attachments?: Attachment[]
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
  // The user item this event delivered (a relaunch's brief, a wakeup's
  // notification), told inside the
  // event's note rather than as the user speaking. See buildTimeline.
  message?: string
}

// An action this task took on another project-qualified task. Kept distinct
// from EventItem, whose subject is always the containing task itself.
export type TaskActionRef = {
  id: string
  projectSlug: string
  title?: string
}

export type TaskActionTrigger =
  | { kind: 'scheduled'; scheduledFor: string }
  | {
      kind: 'awaiting'
      tasks: TaskActionRef[]
      scheduledFor?: string
    }

export type TaskActionItem = ItemCommon &
  {
    kind: 'task-action'
    // The ride this task was on when it acted. buildTimeline hands the action
    // to that turn, which anchors it before its next prose; an action with no
    // ride (or one that streamed nothing) stands on its own in the timeline.
    // Never `rideId` — that would route it into the ride's item log, and this
    // is an account of what the turn did, not a step of it.
    ride?: string
  } &
  (
    | { action: 'launch'; target: TaskActionRef; trigger?: TaskActionTrigger }
    | {
        action: 'message'
        target: TaskActionRef
        trigger?: TaskActionTrigger
        // A clamped echo of what was sent, revealed under the row.
        text?: string
      }
    | { action: 'status'; target: TaskActionRef; toStatus: string }
  )

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

// A task hook's account of itself. A hook run has no task and no ride, so its
// report lands on the target it fired for — which is where someone asking "why
// did this fire" looks.
//
// It carries `ride`, not `rideId`: buildTimeline routes anything with a `rideId`
// into that ride's bubble before it looks at the kind, and the report is about a
// turn rather than part of one.
export type HookItem = ItemCommon & {
  kind: 'hook'
  hook: string
  path: string
  trigger: string
  by: string
  fireId: string
  ride?: string
  outcome: string
  text?: string
  output?: string
  error?: string
  durationMs?: number
}

export type ContextItem = ItemCommon & ContextDetails & {
  kind: 'context'
  action: ContextAction
}

export type NoticeItem = ItemCommon & {
  kind: 'notice'
  text: string
}

export type RepromptItem = ItemCommon & {
  kind: 'reprompt'
  text: string
}

export type Item =
  | ContextItem
  | NoticeItem
  | RepromptItem
  | MessageItem
  | ToolItem
  | EventItem
  | TaskActionItem
  | AskItem
  | HookItem

export type Task = {
  // The task's own short id (a nanoid; legacy tasks carry the uuid they were
  // keyed by). Distinct from the provider session that backs its turns, which
  // the daemon owns and the client never sees.
  id: string
  // LEGACY. Present only on claude/codex tasks; a task created with any other
  // flow has none. Read `flow` instead — the server derives it for every task,
  // including pre-step-4 ones whose only provider field is this.
  agent?: 'claude' | 'codex'
  // The task's driver flow name, derived server-side by publicTask/taskFlow.
  // Optional on the wire only because a response from a pre-step-4 server
  // wouldn't carry it; the current server always does.
  flow?: string
  // Permission rules granted on this task itself ("allow in task"), which the
  // header's grant popup lists. Absent until the first task-scope grant — and on
  // a payload from a server that predates the field — so read undefined as none.
  // Project-scope grants aren't here: they live in the project's settings file.
  allow?: string[]
  title: string
  status: string
  createdAt: string
  updatedAt?: string
  // The read marker: an ISO timestamp the viewer has read the conversation up
  // through. Timeline entries stamped after it are unread (see readMarker.ts).
  // Advanced monotonically via the /seen endpoint, set back by /unread.
  readThrough?: string
  unread?: boolean
  // Set on tasks the server reads from the archive dir (when the list is
  // fetched with ?archived=1). Marks the row and swaps the kebab's Archive item
  // for Restore. Absent on active tasks.
  archived?: boolean
  // ISO timestamp a scheduled task is set to launch; present only while the
  // task is paced and waiting for the server's scheduler (or a manual launch).
  scheduledFor?: string
  // Task ids this task is waiting on (`--after`); the scheduler launches it once
  // all have landed. Present only while awaiting; may coexist with scheduledFor.
  waitingFor?: string[]
  // Deferred messages armed on this task (`lander send/relaunch --date/--time/
  // --after`), each firing on its own trigger. We read `relaunch` (a pending
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
  // (see the server's Task.cwd). Absent until the first turn completes, or when
  // the task never left the project root.
  //
  // NOT where the next turn starts: a `cd` recorded here is a place the agent
  // visited, not necessarily a place it will be again.
  cwd?: string
  // The worktree lander manages for this task (in a project whose config
  // enables them), as of its last turn. Absent for a task that has never run in
  // one.
  checkout?: CheckoutReport
}

// Mirrors server/protocol.ts.
export type CheckoutReport = {
  path: string
  // Absent while the worktree is detached.
  branch?: string
  // Everything changed since the worktree diverged from the main checkout.
  files: ChangedFile[]
}

// Line counts are null for a binary file.
export type ChangedFile = {
  path: string
  added: number | null
  removed: number | null
}

// A task tagged with the slug of the project it came from, so the merged
// cross-project list knows which project's API to hit for each task.
export type TaskWithProject = Task & { projectSlug: string }

// The compact global projection used only for resolving task references. It is
// deliberately independent of Task: the link poll never carries conversations,
// permissions, telemetry, or timestamps.
export type TaskLink = {
  id: string
  projectSlug: string
  title: string
  status: string
  archived: boolean
}

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

// What a flow can do, as every task-list response serves it by flow name
// (server/flows.ts's FlowCaps). `grants.task` = task-scope allow rules are
// honored, `grants.project` = project grants are supported.
export type FlowCaps = Pick<FlowMeta['capabilities'], 'grants'>

// What a driver flow announces about itself, as GET /api/:project/flows serves
// it. Mirrors server/protocol.ts's FlowMeta by hand, like TelemetryItem above.
// The picker renders `name`/`description`; the grant UI reads its flow's
// grants from the list response's FlowCaps instead.
export type FlowMeta = {
  api: number
  name: string
  description: string
  driver: boolean
  capabilities: {
    grants: { task: boolean; project: boolean }
    usageSnapshot: boolean
    rateLimitRetry: boolean
    reportsCost: boolean
  }
  inputs?: Record<string, unknown>
  projectGrantsUnsupportedReason?: string
}

// One hook module a project's tree declares, with the state of the version it
// declares. Mirrors server/hooks.ts's HookOutcome by hand, like FlowMeta above.
//
// `blob` is the version this tree carries; `runs` is the version that would
// actually run, which differs when the declared one is unapproved and an earlier
// version of the same path was approved. `via` and `runsVia` say which of the two
// independent mechanisms approved it: a human approving that exact version, or
// the version being present on the trusted branch.
export type Hook = {
  path: string
  blob: string
  trigger: string
  by: string
  name: string
  state: 'approved' | 'pending'
  via?: 'trust-root' | 'content'
  runs: string | null
  runsVia?: 'trust-root' | 'content'
  reason?: 'unapproved-version' | 'no-approved-version'
  searchTruncated?: boolean
}

// What GET /api/:project/hooks serves: the checkout it read, the trusted branch
// setting, and every declared hook's state.
export type ProjectHooks = {
  cwd: string
  commit?: string
  // Why there is no commit to read hooks from: 'not-a-repo' | 'unborn-head'.
  reason?: string
  trustRoot: {
    ref: string | null
    configured: boolean
    commit?: string
    // Why the named branch could not be read: 'unresolved-ref' | 'invalid-ref'.
    reason?: string
  }
  hooks: Hook[]
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
