export type Step = {
  kind: 'text' | 'tool_use' | 'tool_result'
  text?: string
  tool?: string
  input?: string
  // tool_use: the untruncated, newline-preserving input, revealed under the chip's
  // disclosure. Set by the server only when it says more than the one-line `input`
  // (a multi-line or truncated input); absent for short inputs and older steps.
  inputFull?: string
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
export type ToolStatus = 'ok' | 'blocked' | 'failed' | 'running'

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

export type Message = {
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  steps?: Step[]
  usage?: TokenUsage
  pending?: boolean
  // Set by the server (publicTask) on a follow-up the agent hasn't read yet; the
  // timeline dims it and sinks it below the conversation.
  queued?: boolean
  // Files/images attached to a user message (refs only). Rendered as chips beside
  // the message text — never inlined into the text/markdown.
  attachments?: Attachment[]
  // Named output files an assistant turn published while it ran (refs only).
  // Rendered as rows at the bottom of the message that generated them; the
  // download resolves the slot's current blob by name.
  artifacts?: Artifact[]
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

// A lifecycle event interleaved with messages in the conversation timeline: the
// task's launch, a rename, or a crossing into/out of the wedged (needs the
// user) or terminal landed state. `title` is the task's name as of the event
// (absent on an untitled launch or on events saved before titles were captured).
export type TaskEvent = {
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

export type Task = {
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
export type TaskWithProject = Task & { projectSlug: string }

export type Project = {
  path: string
  slug: string
}

export type UsageWindow = { utilization: number; resetsAt: string | null }
export type Usage = { session: UsageWindow | null; weekly: UsageWindow | null }

// The list's time window: tasks updated today, this week (from Sunday), before
// this week ('older', same Sunday cutoff), or with no bound. 'today'/'week'/
// 'older' also surface in the dropdown title.
export type TimeFilter = 'today' | 'week' | 'older' | 'any'
// Which slice of tasks the list shows: 'inbox' (everything not archived, the
// default), 'unread' (just the inbox tasks with unviewed updates), or
// 'archived'. Mutually exclusive, chosen from the project filter dropdown.
export type TaskView = 'inbox' | 'unread' | 'archived'

export type DateCategory = 'today' | 'week' | 'older'
