// Task message/event types and the small pure helpers over them: the public
// (token-stripped) projection, the "latest completed update" timestamp behind
// the unseen dot, the lifecycle-event recorder, and the in-flight-message
// accessors. Typed structurally so they can be unit-tested without the full
// server Task type (index.ts passes its Task, which satisfies these shapes).

import path from 'node:path'
import type { AgentKind } from './agent'
import type { Step, Usage } from './stream'
import type { Attachment } from './attachments'
import type { Artifact } from './artifacts'
import type { Ask, AskForm } from './asks'

export type Message = {
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  // Files/images attached to a user message (refs only — id/name/mime/size, never
  // the bytes; the durable blobs live in the project's attachmentsDir). Carried
  // separately from `text` (which stays the user's prose): the UI renders these as
  // chips/thumbnails, and driveTask pulls the turn's refs onto the outgoing run so
  // the daemon can materialize them for the agent. Absent on messages with none.
  attachments?: Attachment[]
  // Artifacts (named output files) an assistant turn published while it ran (refs
  // only — the durable blobs live in the project's attachmentsDir, shared with
  // input attachments). Recorded at publish time by recordArtifactOnMessage so the
  // UI can render them under the message that generated them. The task's own
  // `artifacts` slot registry is the source of truth for the latest version;
  // these are the point-in-time refs, and an older one may point at a blob a later
  // republish superseded. Absent on messages that published none.
  artifacts?: Artifact[]
  // Present on assistant turns that were streamed: the live activity trace.
  steps?: Step[]
  // Present on assistant turns once the run's terminal result event lands: the
  // token counts the turn consumed. The UI shows the latest in the corner.
  usage?: Usage
  // True while the assistant is still producing this message; cleared when it lands.
  pending?: boolean
  // Client-facing only: set by publicTask on a follow-up still in the task's
  // `queued` work queue (the agent hasn't read it yet) so the UI can dim it. Derived
  // from the queue at projection time, never stored — the queue is the source of
  // truth — so it's the read/unread analog of the server-owned `pending`.
  queued?: boolean
}

// A noteworthy point in a task's life, shown inline in the conversation
// timeline: its creation ("launched"), a rename, or a crossing into/out of the
// "wedged" (needs the user) or terminal "landed" status. The quiet riding↔
// resting churn during and after a run isn't interesting, so it isn't recorded.
// Each event captures the task's title as of that moment so a later rename
// doesn't change how earlier events read.
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
    // The divider `lander relaunch` records when it seals the task's assistant
    // session so the next turn mints a fresh provider session (see sealForRelaunch).
    // Recorded twice for a scheduled relaunch: once at arm time carrying
    // `scheduledFor` (the pending indicator), then again at delivery without it
    // (the actual divider) — the same pattern a deferred `rest` shows as a
    // 'scheduled' then a 'launched'.
    | 'relaunched'
  // The task's title at the time of the event. Absent on a launch/schedule event
  // until the first generated name amends it, and on events saved before titles
  // were captured.
  title?: string
  // 'scheduled' (and an armed 'relaunched') only: the date/time the task is set
  // to launch/relaunch, shown beside the verb (the event's own createdAt is when
  // it was scheduled).
  scheduledFor?: string
  // 'awaiting' only: the tasks this one is resting on (id + title as of the
  // event) so the UI can render them as links. A task awaiting tasks may also
  // carry a --date/--time fallback, but we don't surface that here — the
  // condition is the point.
  awaiting?: { id: string; title: string }[]
  createdAt: string
}

// A ride: one activation of the task's flow — today an agent turn, mapped 1:1
// onto the daemon run whose `runId` it borrows for its id. Opened when the run is
// handed to the daemon (startRide) and closed when the run finishes (closeRide,
// from applyDone) or is abandoned. `endedAt` absent ⇒ the ride is open (the task
// is actively riding); a closed ride carries an `outcome` and the turn's `usage`.
// Additive for now — the UI still reads Message.usage/steps; see docs/rides-plan.md.
export type Ride = {
  id: string
  startedAt: string
  // Absent while the ride is open. Stamped by closeRide when the run finishes.
  endedAt?: string
  outcome?: 'done' | 'interrupted' | 'error'
  // The turn's token usage, moved off the message onto the ride at close time.
  usage?: Usage
}

// The task's currently-open ride (the last one without an `endedAt`), if any —
// what a riding task is streaming into. Undefined when no run is in flight, and
// for tasks saved before rides existed (no `rides` array).
export function openRide(task: { rides?: Ride[] }): Ride | undefined {
  const rides = task.rides
  if (!rides) return undefined
  for (let i = rides.length - 1; i >= 0; i--) if (!rides[i].endedAt) return rides[i]
  return undefined
}

// Open a ride for a run being handed to the daemon: push `{ id, startedAt }`. The
// id is the daemon runId, so a reattach/close can find the ride by the run it
// tracks. One ride per run.
export function startRide(task: { rides?: Ride[] }, id: string, at: string): void {
  ;(task.rides ??= []).push({ id, startedAt: at })
}

// Close the task's open ride, if any: stamp `endedAt`/`outcome` and (when given)
// move the turn's final `usage` onto it. A no-op when no ride is open — a run
// started before rides existed has none, so callers needn't guard (see the
// missing-ride tolerance in applyDone).
export function closeRide(
  task: { rides?: Ride[] },
  outcome: Ride['outcome'],
  at: string,
  usage?: Usage,
): void {
  const ride = openRide(task)
  if (!ride) return
  ride.endedAt = at
  ride.outcome = outcome
  if (usage) ride.usage = usage
}

// One entry in the unified item log that replaces the parallel `messages[]`,
// `events[]`, and `asks[]` arrays (see docs/conversation-model.md). A
// discriminated union on `kind`; the common fields sit on every kind. Introduced
// unused in step 3 (the converter builds these; nothing serves them yet) and
// wired into storage in step 4.
type ItemCommon = {
  // Stable id: tool items reuse the provider `toolUseId` (so a wire tool_result
  // addresses its item directly), ask items keep their `ask-…` id, and
  // message/event items mint `itm-<epoch36>-<seq>`.
  id: string
  at: string
  // Absent for out-of-ride items (user messages, most events). Present on every
  // item a ride produced (flow messages, tools).
  rideId?: string
  // Nesting: a subagent's items point at the spawning tool item; a natively-written
  // ask points at its raising message item. Generalizes `parentToolUseId`.
  parentId?: string
  // Grouping key (renamed from `inferenceId`): items emitted in one atomic burst.
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
  // Set on a user message once a queued batch delivers it: the ride that consumed
  // it, making the batching visible. Absent on converted history.
  deliveredIn?: string
  // Client-facing only: set by publicTask on a trailing user item still in the
  // task's work queue (the agent hasn't read it yet), the item analog of the old
  // Message.queued. Derived at projection time, never stored.
  queued?: boolean
}

export type ToolItem = ItemCommon & {
  kind: 'tool'
  name: string
  input: string
  inputFull?: string
  rule?: string
  // Folded in from the tool_result: the result peek and the call's outcome.
  // `running` until the result lands.
  output?: string
  status: 'running' | 'ok' | 'failed' | 'blocked'
  edits?: { old: string; new: string }[]
}

export type EventItem = ItemCommon & {
  kind: 'event'
  // Today's TaskEvent.kind, renamed to avoid clashing with the item's own `kind`.
  eventKind: TaskEvent['kind']
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

// ── Item-log builders (v2 storage) ──────────────────────────────────────────

// Mint a message/event item id: `itm-<epoch36>-<seq>` (seq = the task's current
// item count), the same scheme as nextAskId. Tool items reuse the provider
// toolUseId and ask items keep their `ask-…` id instead, so those don't go through
// here.
export function nextItemId(task: { items?: Item[] }, at: string): string {
  return `itm-${Math.floor(Date.parse(at) || 0).toString(36)}-${
    task.items?.length ?? 0
  }`
}

// Append a user message item (out of any ride). `deliveredIn` is stamped later,
// when a queued batch is drained into a ride.
export function pushUserItem(
  task: { items?: Item[] },
  text: string,
  at: string,
  opts: { attachments?: Attachment[]; deliveredIn?: string } = {},
): MessageItem {
  const item: MessageItem = {
    id: nextItemId(task, at),
    at,
    kind: 'message',
    role: 'user',
    text,
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    ...(opts.deliveredIn ? { deliveredIn: opts.deliveredIn } : {}),
  }
  ;(task.items ??= []).push(item)
  return item
}

// Append a flow (assistant/host) message item to a ride.
export function pushFlowItem(
  task: { items?: Item[] },
  rideId: string,
  text: string,
  at: string,
): MessageItem {
  const item: MessageItem = {
    id: nextItemId(task, at),
    at,
    rideId,
    kind: 'message',
    role: 'flow',
    text,
  }
  ;(task.items ??= []).push(item)
  return item
}

// Append a lifecycle event item (out of any ride, like a user message).
export function pushEventItem(
  task: { items?: Item[] },
  ev: {
    eventKind: TaskEvent['kind']
    title?: string
    scheduledFor?: string
    awaiting?: { id: string; title: string }[]
  },
  at: string,
): EventItem {
  const item: EventItem = {
    id: nextItemId(task, at),
    at,
    kind: 'event',
    eventKind: ev.eventKind,
    ...(ev.title !== undefined ? { title: ev.title } : {}),
    ...(ev.scheduledFor !== undefined ? { scheduledFor: ev.scheduledFor } : {}),
    ...(ev.awaiting !== undefined ? { awaiting: ev.awaiting } : {}),
  }
  ;(task.items ??= []).push(item)
  return item
}

// The last main-agent flow message item (a `flow` message with no `parentId`, so
// not a subagent's nested prose), optionally scoped to one ride. The anchor for
// finalText updates (applyUpdate) and artifact refs (recordArtifactOnMessage).
export function lastFlowItem(
  task: { items?: Item[] },
  rideId?: string,
): MessageItem | undefined {
  const items = task.items ?? []
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (
      it.kind === 'message' &&
      it.role === 'flow' &&
      it.parentId === undefined &&
      (rideId === undefined || it.rideId === rideId)
    )
      return it
  }
  return undefined
}

// The user message items in order (out-of-ride `message` items with role `user`).
// The v2 analog of filtering `messages` to role user — used by lastTurnPrompts and
// turnAttachments.
export function userItems(task: { items?: Item[] }): MessageItem[] {
  return (task.items ?? []).filter(
    (it): it is MessageItem => it.kind === 'message' && it.role === 'user',
  )
}

// The lifecycle event items in order (the v2 analog of the old `task.events`).
export function eventItems(task: { items?: Item[] }): EventItem[] {
  return (task.items ?? []).filter((it): it is EventItem => it.kind === 'event')
}

// Record an assistant error/interrupt reply on the task. If a ride is open, fill
// its last empty flow item (or append one) with `text`; otherwise the run never
// opened a ride (an unreadable task file, or no daemon) — synthesize a one-item
// closed error ride so the failure still shows as an assistant turn.
export function recordAssistantError(
  task: { items?: Item[]; rides?: Ride[] },
  text: string,
  at: string,
): void {
  let ride = openRide(task)
  if (!ride) {
    const id = `ride-${Math.floor(Date.parse(at) || 0).toString(36)}-e${
      task.rides?.length ?? 0
    }`
    startRide(task, id, at)
    ride = openRide(task) as Ride
    pushFlowItem(task, ride.id, text, at)
    closeRide(task, 'error', at)
    return
  }
  const last = lastFlowItem(task, ride.id)
  if (last && !last.text) last.text = text
  else pushFlowItem(task, ride.id, text, at)
}

// A repeating-relaunch spec carried on a scheduled relaunch message (`lander
// relaunch --interval <minutes>`): when the message delivers, the scheduler arms
// its successor `interval` minutes later. The next fire is measured off the
// actual delivery time, NOT the nominal schedule — no drift compensation — so a
// series started at 1:00 with a 60m interval fires ~2:01, ~3:02, … as each
// re-arm rides the previous delivery. The series ends at whichever bound is set:
//   - `remaining`: relaunches still to come after the message this rides on;
//     undefined = unbounded. Decrements by one on each re-arm, so a run of N
//     total relaunches starts with remaining = N-1 and stops once it hits 0.
//   - `until`: an ISO cutoff — re-arm only while the successor's fire time is at
//     or before it. Set exclusively of `remaining` (the CLI takes one or neither).
export type RepeatSpec = {
  interval: number
  remaining?: number
  until?: string
}

// A message addressed to a task with a deferred delivery (`lander send/relaunch
// --date/--time/--await`). Fires when its trigger is met — a time (`deliverAt`)
// and/or a condition (`waitFor`, ids that must all land), whichever comes first.
// `relaunch` marks a `lander relaunch` deferral (seals the session on delivery);
// `repeat` rides a repeating relaunch and arms the next on delivery.
export type ScheduledMessage = {
  text: string
  deliverAt?: string
  waitFor?: string[]
  relaunch?: boolean
  repeat?: RepeatSpec
  // Attachment refs sent with a deferred `lander send --files --date/--await`,
  // carried until delivery when they land on the appended user message (like an
  // immediate send). Absent when the deferred message had none.
  attachments?: Attachment[]
}

// Grant-capability flags served on the public task so the UI stops branching on
// the agent kind: `task` = task-scope allow rules are honored, `project` =
// project-scope grants are supported. Derived from the task's agent here — the one
// place that maps an agent to its grant capabilities — so a provider that doesn't
// honor a scope degrades from data rather than a UI `agent === 'codex'` special
// case. codex saves task rules for parity but honors neither scope yet (both
// false); claude supports both. The flow inversion supersedes this switch with
// each flow's announced meta.capabilities (see docs/flow-inversion.md).
export type GrantCaps = { task: boolean; project: boolean }

export function agentGrantCaps(agent: AgentKind): GrantCaps {
  return agent === 'codex'
    ? { task: false, project: false }
    : { task: true, project: true }
}

// Flag the trailing-N user entries (N = queue length) as `queued`, cloning only
// the flagged ones. The unread follow-ups are the trailing user messages, one
// queue entry each, in order — so the client can dim what the agent hasn't read
// without seeing the server's queue. Shared by the native items and the legacy
// messages projections.
function flagQueued<M extends { role: 'user' | 'flow' | 'assistant' }>(
  list: M[],
  queueLen: number,
): M[] {
  if (!queueLen) return list
  const flagged = new Set<number>()
  let remaining = queueLen
  for (let i = list.length - 1; i >= 0 && remaining > 0; i--) {
    if (list[i].role === 'user') {
      flagged.add(i)
      remaining--
    }
  }
  return list.map((m, i) => (flagged.has(i) ? { ...m, queued: true } : m))
}

// Strip the secret `token` (and the server-internal run pointers / retry stash)
// before sending a task over HTTP, so the UI — and any task scraping the API —
// can't read another task's token and impersonate it. `retry` is internal
// bookkeeping the wedge's retry ask supersedes on the wire, so it's stripped too.
// Serves the v2 item log natively (`items`/`rides`); the client and CLI read it
// directly now (the legacy `messages`/`events`/`asks` projection is gone — see
// docs/rides-plan.md step 6). Also derives the served `status` and attaches the
// `grants` flags.
export function publicTask<T extends object>(
  task: T,
): Omit<T, 'token' | 'runId' | 'runCursor' | 'queued' | 'retry'> & {
  grants?: GrantCaps
} {
  const {
    token: _t,
    runId: _r,
    runCursor: _c,
    retry: _retry,
    queued,
    ...rest
  } = task as T & {
    token?: unknown
    runId?: unknown
    runCursor?: unknown
    retry?: unknown
    queued?: string[]
    items?: Item[]
    rides?: Ride[]
  }
  const restT = rest as { items?: Item[]; rides?: Ride[]; status?: string }
  const queueLen = queued?.length ?? 0

  // Native items, with the queued flag projected onto trailing user items.
  if (restT.items) restT.items = flagQueued(restT.items as MessageItem[], queueLen)

  // Derive the served `status` from the collapsed stored vocabulary
  // (`riding | wedged | landed`), so the public wire keeps today's four-word
  // vocabulary byte-for-byte. A stored `riding` task is actively *riding* only
  // while a run is live — an open ride, or (belt for a pre-ride task) a `runId`;
  // with no live run it is idle, served as `resting`, which the UI decorates with
  // any `scheduledFor`/`waitingFor`. `wedged`/`landed` serve as stored.
  const storedStatus = (task as { status?: string }).status
  if (typeof storedStatus === 'string') {
    const hasLiveRun = !!openRide(task as { rides?: Ride[] }) || _r != null
    restT.status =
      storedStatus === 'riding' ? (hasLiveRun ? 'riding' : 'resting') : storedStatus
  }

  // Attach the derived grant capabilities when the task carries an agent (real
  // tasks always do; the structurally-typed test fixtures may not).
  const agent = (task as { agent?: AgentKind }).agent
  const out = {
    ...rest,
    ...(agent ? { grants: agentGrantCaps(agent) } : {}),
  }
  return out as Omit<T, 'token' | 'runId' | 'runCursor' | 'queued' | 'retry'> & {
    grants?: GrantCaps
  }
}

// The timestamp of a task's most recent *completed* update: the newest of its
// finished messages (the in-flight, still-streaming one is skipped) and its
// lifecycle events. Mirrors the client's helper of the same name; used to seed
// `seenAt` for tasks that predate the field. ISO timestamps compare
// lexicographically, so the string max is a chronological max. Empty string
// when nothing has completed yet (e.g. only an in-flight message exists).
export function latestUpdateAt(task: {
  items?: Item[]
  rides?: Ride[]
}): string {
  // Items belonging to the still-open ride are the in-flight turn — skip them, the
  // v2 analog of skipping the pending message. A ride's completion timestamp is its
  // endedAt (there's no single "message" carrying it now).
  const open = openRide(task)
  let latest = ''
  for (const it of task.items ?? []) {
    if (open && it.rideId === open.id) continue
    if (it.at > latest) latest = it.at
  }
  for (const r of task.rides ?? []) {
    if (r.endedAt && r.endedAt > latest) latest = r.endedAt
  }
  return latest
}

// Record a crossing into or out of a "notable" status — "wedged" (the task
// needs the user) or the terminal "landed" — as a timeline event, so the UI can
// show it inline among the messages. Entering a notable status records it
// ("wedged"/"landed"); leaving one for an un-notable status (riding/resting)
// records the inverse ("unwedged"/"unlanded"). A no-op for moves between two
// quiet statuses (e.g. riding↔resting) or that don't change status. Moving
// straight between two notable statuses (wedged↔landed) records the arrival
// only. Call before assigning the new status, while task.status holds the old.
export function recordStatusTransition(
  task: { status: string; title: string; items?: Item[] },
  next: string,
  at: string,
): void {
  const prev = task.status
  if (prev === next) return
  if (next === 'wedged' || next === 'landed')
    pushEventItem(task, { eventKind: next, title: task.title }, at)
  else if (prev === 'wedged' || prev === 'landed')
    pushEventItem(
      task,
      {
        eventKind: prev === 'wedged' ? 'unwedged' : 'unlanded',
        title: task.title,
      },
      at,
    )
}

// Seal a task's assistant session so its next turn mints a fresh provider session,
// and record the 'relaunched' divider event. This is the heart of `lander
// relaunch`: the daemon starts a new provider session whenever it's handed a
// turn with no `sessionId` (it resumes the same one otherwise), so deleting the
// field is all it takes — the new session is minted lazily on the next turn that
// drains a queued message, never pre-allocated. The old session's still-streaming
// turn emits no session announcement, so nothing races this clear (see
// reduceRunWs's set-once `if (!t.sessionId)`). Touches only session + event
// state; the caller owns the message/queue/status for the next turn.
export function sealForRelaunch(
  task: {
    sessionId?: string
    turnContext?: string
    title: string
    items?: Item[]
  },
  at: string,
): void {
  delete task.sessionId
  // The recorded context baseline belongs to the sealed session; drop it so the
  // fresh session's first turn gets the full dynamic context block again.
  delete task.turnContext
  pushEventItem(task, { eventKind: 'relaunched', title: task.title }, at)
}

// The immediate `lander relaunch <message>` mutation: seal the session, then
// append the relaunch message and queue it for the (now fresh) session, going
// riding. Called mid-turn of the old session in the normal path — the in-flight
// driveTask loop drains the queued message after the current turn's `done`, and
// because the session is sealed that turn hands the daemon no `sessionId`, so a
// new provider session is minted. Revives a wedged/landed task too (records the
// un-wedge a hair ahead so the timeline orders right), and supersedes any
// pending retry.
export function applyRelaunch(
  task: {
    sessionId?: string
    status: string
    title: string
    updatedAt?: string
    items?: Item[]
    queued?: string[]
    scheduledMessages?: ScheduledMessage[]
    retry?: unknown
  },
  message: string,
  at: string,
  repeat?: RepeatSpec,
): void {
  recordStatusTransition(task, 'riding', new Date(Date.parse(at) - 1).toISOString())
  sealForRelaunch(task, at)
  pushUserItem(task, message, at)
  ;(task.queued ??= []).push(message)
  task.status = 'riding'
  task.updatedAt = at
  delete task.retry
  // A repeating relaunch (`--interval`) arms its next occurrence off this
  // (immediate) delivery; each later occurrence re-arms itself in applyDueMessages
  // when it in turn delivers. Nothing is armed once the series' bound is reached.
  if (repeat) {
    const next = nextRepeatMessage({ text: message, repeat }, at)
    if (next) (task.scheduledMessages ??= []).push(next)
  }
}

// Build the successor of a repeating relaunch (`--interval`) that just delivered
// at `at`, or return null when the series has reached its bound. The successor
// fires `interval` minutes after the actual delivery (no drift compensation),
// carries the same text, and decrements `remaining`. Shared by the immediate
// (applyRelaunch) and scheduled (applyDueMessages) delivery paths, so every
// occurrence — the first and each re-arm — advances the series the same way.
export function nextRepeatMessage(
  entry: { text: string; repeat?: RepeatSpec },
  at: string,
): ScheduledMessage | null {
  const r = entry.repeat
  if (!r) return null
  // Count bound: stop once no relaunches remain after the one that just fired.
  if (r.remaining != null && r.remaining <= 0) return null
  const nextAt = new Date(Date.parse(at) + r.interval * 60_000).toISOString()
  // Time bound: stop once the successor would fire past the cutoff.
  if (r.until != null && Date.parse(nextAt) > Date.parse(r.until)) return null
  return {
    text: entry.text,
    deliverAt: nextAt,
    relaunch: true,
    repeat: {
      interval: r.interval,
      ...(r.remaining != null ? { remaining: r.remaining - 1 } : {}),
      ...(r.until != null ? { until: r.until } : {}),
    },
  }
}

// Append a batch of now-due scheduled messages and queue them for the session —
// the shared tail of an immediate and a scheduled delivery. If any due entry is
// a relaunch (`lander relaunch --date/--time/--await`), seal the session once and
// lead with the relaunch text so the fresh session reads it first; ordinary due
// messages keep their order and follow. The caller has already split due from
// not-yet-due and recorded the riding transition; this only mutates the
// session/message/queue state.
export function applyDueMessages(
  task: {
    sessionId?: string
    title: string
    items?: Item[]
    queued?: string[]
    scheduledMessages?: ScheduledMessage[]
  },
  due: ScheduledMessage[],
  at: string,
): void {
  const relaunch = due.filter((m) => m.relaunch)
  const rest = due.filter((m) => !m.relaunch)
  // Seal once even if several relaunch entries are due in the same sweep.
  if (relaunch.length) sealForRelaunch(task, at)
  for (const m of [...relaunch, ...rest]) {
    pushUserItem(task, m.text, at, {
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    })
    ;(task.queued ??= []).push(m.text)
  }
  // Re-arm the next occurrence of any repeating relaunch (`--interval`) that just
  // delivered, measured off this delivery — the deferred analog of applyRelaunch's
  // arming. Nothing is armed once the series' count/until bound is reached.
  for (const m of relaunch) {
    const next = nextRepeatMessage(m, at)
    if (next) (task.scheduledMessages ??= []).push(next)
  }
}

// Arm a scheduled relaunch: stash a relaunch-flagged scheduled message whose own
// `deliverAt`/`waitFor` trigger seals the session on delivery, and record a
// pending 'relaunched' event (carrying the launch time, when known) so the UI
// shows the coming relaunch. Crucially does NOT clear `sessionId` now — the old
// session stays live until the trigger fires, so pre-trigger interim messages
// still resume it, consistent with every other scheduled wakeup. We deliberately
// don't set task-level `scheduledFor` (that would block delivery and could
// double-fire launchTask); the message's own trigger drives it. A `repeat` spec
// (`--interval`) rides along and re-arms the next occurrence on each delivery.
export function armScheduledRelaunch(
  task: {
    title: string
    items?: Item[]
    scheduledMessages?: ScheduledMessage[]
  },
  entry: { text: string; deliverAt?: string; waitFor?: string[]; repeat?: RepeatSpec },
  at: string,
): void {
  ;(task.scheduledMessages ??= []).push({ ...entry, relaunch: true })
  pushEventItem(
    task,
    {
      eventKind: 'relaunched',
      title: task.title,
      ...(entry.deliverAt ? { scheduledFor: entry.deliverAt } : {}),
    },
    at,
  )
}

// Recover a task wedged on an assistant error (the shared body of the retry ask
// answer and the old /retry route): re-queue the failed turn — a "try again"
// nudge when the turn had committed (re-sending would duplicate it) or nothing
// concrete to re-send, else the un-received prompt(s) — then either revive the
// task now or, when `defer` and a future `resetsAt` are given, keep it wedged and
// schedule the recovery for the reset time (drained by launchTask at the wakeup,
// exactly as the deferred retry always did). Reads and clears the `retry` stash.
export function applyRetryRecovery(
  task: {
    status: string
    title: string
    updatedAt?: string
    items?: Item[]
    queued?: string[]
    scheduledFor?: string
    retry?: { committed: boolean; prompts: string[]; resetsAt?: string }
  },
  opts: { defer: boolean; resetsAt?: string; now: string },
): void {
  const { defer, resetsAt, now } = opts
  if (!task.retry) return
  const resend = task.retry.prompts.filter((p) => p.trim())
  if (task.retry.committed || !resend.length) {
    pushUserItem(task, 'try again', now)
    task.queued = [...(task.queued ?? []), 'try again']
  } else {
    task.queued = [...(task.queued ?? []), ...resend]
  }
  if (defer && resetsAt) {
    // Scheduling is not an un-wedge: stay wedged (the moon shows via
    // scheduledFor) until launchTask fires and drains the queued recovery.
    task.scheduledFor = resetsAt
    pushEventItem(
      task,
      { eventKind: 'scheduled', title: task.title, scheduledFor: resetsAt },
      now,
    )
  } else {
    recordStatusTransition(task, 'riding', new Date(Date.parse(now) - 1).toISOString())
    task.status = 'riding'
  }
  task.updatedAt = now
  delete task.retry
}

// The user messages that made up a task's most recent turn: the consecutive run
// of user messages immediately before the trailing assistant message(s). After a
// turn ends (or errors) the assistant's reply is the last message, with that
// turn's prompt(s) just before it — a batched turn carries several. Used by the
// retry path to re-send a turn whose prompt never reached the session.
export function lastTurnPrompts(task: { items?: Item[] }): string[] {
  const items = task.items ?? []
  const isUser = (it: Item) => it.kind === 'message' && it.role === 'user'
  let i = items.length - 1
  // Skip the trailing assistant turn (the last ride's items) and any events.
  while (i >= 0 && !isUser(items[i])) i--
  const prompts: string[] = []
  while (i >= 0 && isUser(items[i])) {
    prompts.unshift((items[i] as MessageItem).text)
    i--
  }
  return prompts
}

// The attachment refs carried by the trailing `count` user messages — the ones a
// just-drained turn is made of (driveTask drains the whole `queued` array at once,
// one entry per trailing unread user message; see the trailing-N rule publicTask
// relies on). Gathered in message order and flattened, so the daemon materializes
// exactly this turn's attachments (not the task's whole history). Returns [] when
// none of those messages carried any.
export function turnAttachments(
  task: { items?: Item[] },
  count: number,
): Attachment[] {
  const items = task.items ?? []
  const picked: MessageItem[] = []
  let remaining = count
  for (let i = items.length - 1; i >= 0 && remaining > 0; i--) {
    const it = items[i]
    if (it.kind === 'message' && it.role === 'user') {
      picked.push(it)
      remaining--
    }
  }
  picked.reverse()
  const out: Attachment[] = []
  for (const it of picked) {
    if (it.attachments?.length) out.push(...it.attachments)
  }
  return out
}

// Record an artifact ref on the flow message item that generated it, so the UI
// renders the output row under it. Prefers the open ride's last main-agent flow
// item (the common publish-during-a-run case), else the last flow item overall; if
// the task has none yet, this is a no-op and the task's slot registry alone holds
// the artifact. Republishing a name updates that item's ref in place — one chip per
// output name, always the latest blob. A ref left on an earlier item keeps its old
// size but stays correct to click: downloads resolve by slot name, serving latest.
export function recordArtifactOnMessage(
  task: { items?: Item[]; rides?: Ride[] },
  artifact: Artifact,
): void {
  const ride = openRide(task)
  const host = (ride && lastFlowItem(task, ride.id)) ?? lastFlowItem(task)
  if (!host) return
  const refs = (host.artifacts ??= [])
  const existing = refs.findIndex((r) => r.name === artifact.name)
  if (existing >= 0) refs[existing] = artifact
  else refs.push(artifact)
}

// Derive the name to pass to `claude --worktree` from the absolute worktree root
// the EnterWorktree hook reported (its `worktreePath`), given the project root.
// Worktrees the agent enters live under `<project>/.claude/worktrees/<name>`, and
// `--worktree <name>` re-enters one by that name — so the name is just the path
// relative to that dir (kept whole, so a slash-segmented worktree name survives).
// Returns undefined when the path isn't a worktree under this project, so a stray
// path can never set a bogus flag that would strand every future turn.
export function worktreeName(
  projectPath: string,
  worktreePath: string,
): string | undefined {
  const dir = path.join(projectPath, '.claude', 'worktrees')
  const rel = path.relative(dir, worktreePath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  return rel
}
