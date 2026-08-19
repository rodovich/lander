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
import type { RevivedMarker } from './protocol'
// The one value we import (the rest of this module's imports are types):
// recordStatusTransition settles open asks on the crossing. asks.ts imports only
// types from here, so the runtime edge stays one-way — this module → asks.ts.
import { withdrawOpenAsks, type Ask, type AskForm } from './asks'
import { LEGACY_FLOW, flowCaps, type FlowCaps } from './flows'

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
  // Present only on an 'error' outcome: the exit code, the daemon's cause when
  // it synthesized the done itself (idle-timeout / daemon-shutdown / host-crash,
  // plus the expired window for an idle kill), and the tail of the run's stderr.
  // The durable diagnostic record — applyDone previously dropped stderr entirely
  // once anything had streamed, leaving an error ride with no evidence of why.
  error?: { exitCode?: number; cause?: string; idleMs?: number; stderr?: string }
}

// ── The task-hook trigger funnel ────────────────────────────────────────────
//
// A fire is recorded when a task crosses into or out of a notable status, or
// when a ride closes. Recording is all that happens here: it is synchronous,
// inside the task-file mutation lock, and does no resolution — which hooks a
// tree declares is a git question the daemon answers, later, off the sweep.
//
// The entry is durable and cleared only on a completion report, so an
// interrupted dispatch is retried. That is what makes the fire id load-bearing
// rather than decorative: accepted actions are recorded against it, so a retry
// of the same fire cannot act twice.

export type PendingHook = {
  // `fire-<seq>-<epoch36>`. The counter is persisted so it cannot restart, and
  // the timestamp is belt — an id that could recur would silently dedupe a
  // genuine action into a no-op against a pruned action record.
  id: string
  // landed | unlanded | wedged | unwedged | ride-ended.
  trigger: string
  // The principal that caused it: human | agent | task | system. An open set of
  // directory names, not a closed union — adding a principal must not mean
  // editing a mirrored type.
  by: string
  at: string
  // `ride-ended` only: the ride that closed, and how. A gate reads the segment
  // that ride belongs to, and a closed ride is not otherwise identifiable from
  // the fire.
  rideId?: string
  outcome?: string
  // Dispatch attempts, per hook path, attributable to the fire itself. A hold —
  // no daemon, a draining daemon, a timeout — is deliberately not one of these.
  attempts?: Record<string, number>
  // Hook paths that have reported terminally. The unit of work is (fire, hook),
  // not the entry: with two hooks declared for one trigger and one failing, a
  // per-entry retry would re-run the healthy body too.
  done?: string[]
}

// How many undispatched fires a task may hold. A ceiling rather than a
// guarantee: the funnel lands before the dispatcher, and a daemon outage holds
// entries rather than dropping them, so without this a task could accumulate one
// per ride end indefinitely. Oldest first, and the drop is reported — silence
// would lose exactly the longest-unsupervised ones.
export const MAX_PENDING_HOOKS = 20

type HookFireTask = {
  pendingHooks?: PendingHook[]
  hookFireSeq?: number
  items?: Item[]
}

// Record a fire, returning it along with any entries the cap displaced.
//
// A displaced entry says so on the timeline. The other two ceilings (attempts,
// age) report from the dispatcher; this one has to report here, and it is the
// worst of the three to lose silently — the cap drops OLDEST first, so during a
// daemon outage the entry it discards is the longest-unsupervised one.
export function recordHookFire(
  task: HookFireTask,
  fire: Omit<PendingHook, 'id'>,
): { entry: PendingHook; dropped: PendingHook[] } {
  const seq = (task.hookFireSeq = (task.hookFireSeq ?? 0) + 1)
  const entry: PendingHook = {
    id: `fire-${seq}-${Math.floor(Date.parse(fire.at) || 0).toString(36)}`,
    ...fire,
  }
  const pending = (task.pendingHooks ??= [])
  pending.push(entry)
  const dropped =
    pending.length > MAX_PENDING_HOOKS
      ? pending.splice(0, pending.length - MAX_PENDING_HOOKS)
      : []
  for (const lost of dropped)
    pushHookItem(
      task,
      {
        hook: lost.trigger,
        path: '',
        trigger: lost.trigger,
        by: lost.by,
        fireId: lost.id,
        ...(lost.rideId ? { ride: lost.rideId } : {}),
        outcome: 'dispatch-failed',
        error:
          `dropped without running: more than ${MAX_PENDING_HOOKS} fires were ` +
          `waiting to be dispatched`,
      },
      fire.at,
    )
  return { entry, dropped }
}

// ── The action bound and the retry dedupe ──────────────────────────────────
//
// One record, on the TARGET. A counter keyed by (hook, target) IS a set of
// accepted actions with its size taken, so the runaway bound and the retry
// dedupe are the same structure rather than two that must agree.
//
// The bound counts ACTIONS, not fires: a supervisor that correctly finds nothing
// on ten consecutive rides must stay armed. It resets on human contact, the one
// signal a runaway cannot manufacture — and neither an action nor a message from
// another task may reset it.

export type HookAction = {
  // The hook's PATH, which is its identity. Not its display name: two hooks can
  // share a filename at different triggers, and the bound is per hook.
  hook: string
  fireId: string
  // The body's `opts.key` when it gave one, else a host-minted ordinal within
  // the fire. Never a hash of a body-composed payload: the payload is the body's,
  // so a message carrying a timestamp hashes differently on a retry and acts
  // twice — and hooks.md §8 states retry-safety as a PLATFORM guarantee, which a
  // body-derived key can only deliver for bodies that happen to be deterministic.
  key: string
  kind: 'nudge' | 'land'
  at: string
}

// How many actions one hook may take against one target between human contacts.
export const HOOK_ACTION_BOUND = 3
// How many entries the record keeps. A long-lived task's record must not grow
// without bound on a 2-second list poll.
export const MAX_HOOK_ACTIONS = 50

type HookActionTask = {
  hookActions?: HookAction[]
  hookActionsResetAt?: string
}

// Accept an action against this target, or refuse it.
//
// Called only from inside a `mutateTask` callback, so the check and the write are
// one atomic read-modify-write on the target's file — two concurrent fires cannot
// both see room under the bound.
//
// The caller must run every OTHER refusal (a wedged target, a riding one) BEFORE
// this: a refusal that has already consumed a bounded slot would let three
// unlucky dispatches — a fire lands up to a sweep plus a body's runtime after the
// ride closed, by which time the target is often busy again — stand the hook down
// until a human intervened, reporting `bound`, which reads exactly like a runaway
// it correctly stopped.
export function acceptHookAction(
  task: HookActionTask,
  action: Omit<HookAction, 'at'> & { at: string },
): { ok: true; entry: HookAction; deduped?: true } | { ok: false; reason: 'bound' } {
  const actions = (task.hookActions ??= [])

  // The dedupe. An interrupted run is retried, so the same fire can present the
  // same action twice; the second is a no-op that does NOT increment the bound —
  // a retry storm must not exhaust it.
  const existing = actions.find(
    (a) => a.hook === action.hook && a.fireId === action.fireId && a.key === action.key,
  )
  if (existing) return { ok: true, entry: existing, deduped: true }

  // The bound. Strictly greater than the reset stamp: both are millisecond
  // `toISOString()`, so an action in the same millisecond as the reset is on the
  // far side of it. Counted across kinds, because the loop it bounds can run
  // through either verb.
  const since = task.hookActionsResetAt ?? ''
  const taken = actions.filter((a) => a.hook === action.hook && a.at > since).length
  if (taken >= HOOK_ACTION_BOUND) return { ok: false, reason: 'bound' }

  const entry: HookAction = { ...action }
  actions.push(entry)
  if (actions.length > MAX_HOOK_ACTIONS)
    actions.splice(0, actions.length - MAX_HOOK_ACTIONS)
  return { ok: true, entry }
}

// Record that a ride ended, for the `ride-ended` trigger.
//
// Called where a ride actually TRANSITIONS TO CLOSED with an outcome — a rule,
// not a list of functions, and deliberately not from `closeRide` itself.
// `closeRide` is also called by `recoverQueues`, which runs on every server boot
// and therefore on every `server/**` edit under `tsx watch`; sourcing there
// would fire a burst of hooks every time someone develops lander in the instance
// doing the developing. It is called by driveTask's finally too. Both close
// rides as `interrupted`, which is filtered below anyway — but the rule is what
// keeps a future third caller from being wrong by accident.
//
// `interrupted` is not recorded at all. An interrupt is a deliberate stop by a
// human or a sibling, which has already recorded its own status crossing with
// the right principal; firing supervision there is the "nudge it back to work
// and undo the interrupt" failure the design names. This does NOT swallow the
// mechanical-failure case the trigger exists for: an idle-timeout kill settles
// `{ interrupted: false, exitCode: 1 }`, so it arrives here as `error`.
export function recordRideEnded(
  task: HookFireTask,
  ride: Ride | undefined,
  outcome: Ride['outcome'],
  at: string,
): { entry: PendingHook; dropped: PendingHook[] } | null {
  // Nothing transitioned: a late `done` for a ride some other path already
  // closed must not emit a fire naming a ride that ended for another reason at
  // another time.
  if (!ride) return null
  if (outcome !== 'done' && outcome !== 'error') return null
  return recordHookFire(task, {
    trigger: 'ride-ended',
    // A clean end is the agent finishing its own turn; an error is the
    // platform's doing. Neither is ever `human` or `task`, so hooks under
    // `ride-ended/human/` and `…/task/` are structurally dead directories.
    by: outcome === 'done' ? 'agent' : 'system',
    at,
    rideId: ride.id,
    outcome,
  })
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
  // item a ride produced (flow messages, tools, agent-raised asks).
  rideId?: string
  // Nesting: a subagent's items point at the spawning tool item. Generalizes
  // `parentToolUseId`.
  parentId?: string
  // Grouping key (renamed from `inferenceId`): items emitted in one atomic burst.
  // Not 1:1 with items — one inference fans out into a text block plus a parallel
  // tool batch. A change between consecutive items rules a collapse line.
  groupId?: string
}

export type MessageItem = ItemCommon & {
  kind: 'message'
  // `hook` is a task hook's nudge: a finding appended and driven as a turn. It is
  // deliberately not `user` — it would otherwise enter lastTurnPrompts (so a
  // failed turn would re-send the hook's words as the user's) and a hook reading
  // "the user's messages" would read a previous hook's output as user intent.
  // Not `flow` either, which would make it indistinguishable from the target's
  // own assistant output.
  role: 'user' | 'flow' | 'hook'
  text: string
  // Which hook spoke, on a `hook` message. Carried rather than left to be parsed
  // out of the attributed text: `path` is a hook's identity, and a body asking
  // "did I already nudge this span" must not have to regex a display prefix.
  from?: { hook: string; path: string; fireId: string }
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

// A hook run's account of itself, on the target's timeline.
//
// A hook run has no task and no ride of its own, so this is where "why did this
// fire, or why didn't it" gets answered. It records what the body reported plus
// the host's captured output — a body stays debuggable without a rendered
// transcript, which is the price of not creating a task per fire.
//
// It carries `ride`, never `rideId`: buildTimeline routes any item with a
// `rideId` into the ride bubble before it looks at the kind, and counts it
// toward `ridesWithItems`, which changes where an anchored ask renders. The
// report belongs beside the conversation, not inside the turn it is about.
export type HookItem = ItemCommon & {
  kind: 'hook'
  // The hook's display name and the path that is its identity.
  hook: string
  path: string
  trigger: string
  by: string
  fireId: string
  // The ride a `ride-ended` fire answered, when there was one.
  ride?: string
  // ran | refused | credential-unknown | error | timeout | dispatch-failed
  outcome: string
  // What ctx.report was given, joined.
  text?: string
  // The tail of what the body wrote. NOTE for hook authors: this is served on
  // the task's public record, so whatever a body prints is published, not
  // logged.
  output?: string
  error?: string
  // How long the run took, so a fire's cost is observable without reading logs.
  durationMs?: number
}

export type Item = MessageItem | ToolItem | EventItem | AskItem | HookItem

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

// Append a task hook's nudge: a finding the hook wants the target to act on,
// queued as a prompt like a message and recorded as its own role.
//
// The text carries the attribution (`From hook <name>:`) because a prompt has no
// roles — the agent sees only the joined queue — while `from` carries the
// identity structurally, for anything that needs to ask which hook spoke.
export function pushHookMessageItem(
  task: { items?: Item[] },
  text: string,
  from: NonNullable<MessageItem['from']>,
  at: string,
): MessageItem {
  const item: MessageItem = {
    id: nextItemId(task, at),
    at,
    kind: 'message',
    role: 'hook',
    text,
    from,
  }
  ;(task.items ??= []).push(item)
  return item
}

// Append a hook run's report (out of any ride, like a user message or an event).
//
// Deliberately does NOT bump `updatedAt`: the sidebar sorts on it, so a report
// would resurface a resting task to the top of the list for a finding that, in a
// report-only hook, nobody is being asked to act on — at the gate's own measured
// rate, on roughly a fifth of all ride ends.
export function pushHookItem(
  task: { items?: Item[] },
  hook: Omit<HookItem, 'id' | 'at' | 'kind'>,
  at: string,
): HookItem {
  const item: HookItem = {
    id: nextItemId(task, at),
    at,
    kind: 'hook',
    ...hook,
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
// The v2 analog of filtering `messages` to role user. Used where the question is
// genuinely "what did the human say" — the opening prompt a title is generated
// from, the goal a summary is built against.
export function userItems(task: { items?: Item[] }): MessageItem[] {
  return (task.items ?? []).filter(
    (it): it is MessageItem => it.kind === 'message' && it.role === 'user',
  )
}

// The message items that carry a queued prompt: a human's, or a hook's nudge.
//
// This is the window `task.queued` is made of, and it is NOT `userItems`. A nudge
// pushes text onto the queue exactly as a message does, so anything deriving
// "which items is the queue made of" from role `user` alone counts the wrong
// item — most damagingly deliverQueuedBatch, which would stamp `deliveredIn` on
// an older human message and move it to the tail of the log, durably reordering
// the conversation on the first nudge a task ever receives.
export function promptItems(task: { items?: Item[] }): MessageItem[] {
  return (task.items ?? []).filter(
    (it): it is MessageItem =>
      it.kind === 'message' && (it.role === 'user' || it.role === 'hook'),
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
  task: {
    items?: Item[]
    rides?: Ride[]
    pendingHooks?: PendingHook[]
    hookFireSeq?: number
  },
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
    // This branch does not merely close a ride — it OPENS and closes a complete
    // one, so it is a third place a ride transitions to closed with an outcome,
    // alongside applyDone and the platform-kill branch. Its live callers are
    // runTurn's pre-startRide failures: no daemon serving the project, and a
    // flow the primary has not announced. Those are exactly the "wedged for
    // mechanical reasons" case supervision exists for, so omitting them would
    // leave the trigger blind to its own motivating example.
    recordRideEnded(task, ride, 'error', at)
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

// The driver flow a task runs under — the single reader every server read of a
// task's provider goes through.
//
// A PERMANENT union-read, not a migration window. Nothing rewrites pre-step-4
// tasks, so `agent` stays the answer for every task created before `flow`
// existed, forever. This deliberately diverges from flow-inversion.md's
// "backfill agent:'claude' → flow:'claude'" sentence, following instead the
// precedent step 1 set for sessionId/turnContext: same observable behavior, no
// migration pass, and no half-migrated window in which a task has neither field
// or both disagree.
export function taskFlow(task: { flow?: string; agent?: string }): string {
  return task.flow ?? task.agent ?? LEGACY_FLOW
}

// Grant-capability flags served on the public task so the UI stops branching on
// the provider: `task` = task-scope allow rules are honored, `project` =
// project-scope grants are supported. Now sourced from the flow's ANNOUNCED
// meta.capabilities (see server/flows.ts) rather than a compiled switch on the
// agent kind — which is what lets a flow the server has never been compiled
// against describe its own capabilities.
export type GrantCaps = { task: boolean; project: boolean }

// Flag the trailing-N user entries (N = queue length) as `queued`, cloning only
// the flagged ones. The unread follow-ups are the trailing user messages, one
// queue entry each, in order — so the client can dim what the agent hasn't read
// without seeing the server's queue. Shared by the native items and the legacy
// messages projections.
function flagQueued<M extends { role: 'user' | 'flow' | 'assistant' | 'hook' }>(
  list: M[],
  queueLen: number,
): M[] {
  if (!queueLen) return list
  const flagged = new Set<number>()
  let remaining = queueLen
  for (let i = list.length - 1; i >= 0 && remaining > 0; i--) {
    // A hook's nudge occupies a queue slot exactly as a user message does, so the
    // trailing-N window spans both or it dims the wrong message.
    if (list[i].role === 'user' || list[i].role === 'hook') {
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
  opts?: { caps?: FlowCaps },
): Omit<
  T,
  | 'token'
  | 'runId'
  | 'runCursor'
  | 'queued'
  | 'retry'
  | 'flowState'
  | 'flowStateRev'
  | 'hookFireSeq'
  | 'hookActionsResetAt'
  | 'hookActions'
> & {
  flow: string
  grants: GrantCaps
  reportsCost: boolean
} {
  const {
    token: _t,
    runId: _r,
    runCursor: _c,
    retry: _retry,
    // The flow's durable state is server-internal (like the run pointers) — it
    // rides back to the flow on start-run, never over HTTP. Absent today.
    flowState: _fs,
    flowStateRev: _fsr,
    // Hook bookkeeping with no reader outside this process: a fire-id counter,
    // the timestamp the action bound resets from, and the accepted actions it
    // counts. `pendingHooks` DOES ride out — "was a fire ever recorded" is the
    // first question anyone debugging a hook asks, and it is self-contained —
    // but every field served here is a promise to callers who never run this
    // code. `hookActions` in particular would be a promise worth nothing:
    // without the reset stamp beside it, a reader cannot compute the bound,
    // which is the only question the list answers.
    hookFireSeq: _hfs,
    hookActionsResetAt: _hra,
    hookActions: _ha,
    queued,
    ...rest
  } = task as T & {
    token?: unknown
    runId?: unknown
    runCursor?: unknown
    retry?: unknown
    flowState?: unknown
    flowStateRev?: unknown
    hookFireSeq?: unknown
    hookActionsResetAt?: unknown
    hookActions?: unknown
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

  // Attach the capability flags from the flow's ANNOUNCED meta, so the client
  // reads capabilities and never the agent name.
  //
  // The default resolves here rather than being injected at the route layer.
  // Injection was tried and reverted: publicTask has ~25 call sites, all of
  // which attach these today, and a no-default options object would silently
  // drop both fields from the ~23 that didn't opt in — including
  // GET /tasks/:id, which is what a flow's own ctx.view() reads. Worse, the
  // regression would be invisible to a UI check, since the UI polls only the
  // list endpoint. The purity cost of reading process-global registry state
  // from a serializer is real and accepted; the registry is already global and
  // already read on this request path.
  //
  // The options object stays because it is arity-immune (a bare
  // `.map(publicTask)` would otherwise bind the array index to it) and gives
  // tests a way to pin caps.
  const flow = taskFlow(task as { flow?: string; agent?: string })
  const caps = opts?.caps ?? flowCaps(flow)
  const out = {
    ...rest,
    // The task's driver flow, derived. Served additively alongside `agent`
    // until the client stops reading the latter — a pre-step-4 task has no
    // stored `flow`, so this is where its `agent` becomes one.
    flow,
    grants: caps.grants,
    reportsCost: caps.reportsCost,
  }
  return out as Omit<
    T,
    | 'token'
  | 'runId'
  | 'runCursor'
  | 'queued'
  | 'retry'
  | 'flowState'
  | 'flowStateRev'
  | 'hookFireSeq'
  | 'hookActionsResetAt'
  | 'hookActions'
  > & {
    flow: string
    grants: GrantCaps
    reportsCost: boolean
  }
}

// The public task without its conversation: everything `publicTask` serves,
// minus `items`/`rides`, for callers that only need a task's metadata (the
// client's link-resolution poll, `lander list`). Those two arrays are ~99% of a
// list response's bytes.
//
// Projection order is load-bearing. `publicTask` derives the served `status`
// from `rides` (above): a stored `riding` task with no open ride is served
// `resting`. So the full projection runs FIRST and the arrays come off its
// *output* — dropping them on the way in would demote every riding task to
// resting, emptying the UI's riding section and killing the row spinner.
//
// `scheduledMessages` rides through `publicTask` carrying each deferred
// message's full text, so it is projected too, down to the fields the list
// consumers read (`bin/task-metadata.js`). The `.map` is index-preserving —
// entry `[0]` is read positionally — so a message with none of these fields
// still occupies its slot.
export function taskSummary<T extends object>(task: T, opts?: { caps?: FlowCaps }) {
  const full = publicTask(task, opts)
  const {
    items: _items,
    rides: _rides,
    // `pendingHooks` goes too. It is capped and small, but this projection feeds
    // the link-resolution poll, whose whole purpose is to be id/slug/title/status
    // and nothing else — it was made to shrink that payload, and quietly
    // re-growing it is the one thing it must not do. (`hookActions` needs no
    // strip here: publicTask, which this projects, already drops it.)
    pendingHooks: _pending,
    scheduledMessages: scheduled,
    ...rest
  } = full as typeof full & {
    items?: Item[]
    rides?: Ride[]
    pendingHooks?: PendingHook[]
    scheduledMessages?: ScheduledMessage[]
  }
  return {
    ...rest,
    ...(scheduled
      ? {
          scheduledMessages: scheduled.map((m) => ({
            ...(m.deliverAt != null ? { deliverAt: m.deliverAt } : {}),
            ...(m.relaunch != null ? { relaunch: m.relaunch } : {}),
            ...(m.repeat != null ? { repeat: m.repeat } : {}),
          })),
        }
      : {}),
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
//
// The crossing into `landed` also disarms any wakeup the task was still holding
// (`scheduledFor`/`waitingFor`): landing is terminal, so a surviving trigger can
// only resurrect a finished task to report it has nothing to do.
//
// A crossing also settles any ask left open, because a task-blocking ask is only
// live while the task sits where the ask put it: the wedge ending IS the end of
// the ask, by whatever route the task left — answering, a fresh message, a manual
// un-wedge, a scheduled wakeup, a rest, a land. Entering `wedged` is the one
// exception, and the reason is that it's the crossing that *raises* an ask
// (`lander wedge`, wedgeForRetry): settling one on the way in would eat the ask
// being raised.
//
// This lives on the crossing rather than in the callers because every route that
// moves a task must come through here to record the move — so the rule can't be
// forgotten by the next one. It used to be the callers' job, and of the six paths
// that needed it, three had quietly missed it.
//
// Note what this deliberately does NOT cover: a riding↔resting move isn't a
// crossing (both store as `riding`, so this returns early), which is exactly
// right for an advisory `lander ask` — it never wedged, so resting with the
// question still on screen is the point. Superseding one of those is a different
// rule, about new user intent rather than status, and stays with the paths that
// carry it.
// `by` names the principal that caused the crossing, for task hooks: a hook
// lives at `.lander/hooks/<trigger>/<by>/`, so this value is half the selection
// axis. Required rather than defaulted, because a default would make every new
// call site silently `system` — and `system` is the value that matches no
// `human/` or `agent/` hook at all.
export function recordStatusTransition(
  task: {
    status: string
    title: string
    items?: Item[]
    revived?: RevivedMarker
    scheduledFor?: string
    waitingFor?: string[]
    pendingHooks?: PendingHook[]
    hookFireSeq?: number
  },
  next: string,
  at: string,
  by: string,
): void {
  const prev = task.status
  if (prev === next) return
  // Entering a notable status records the arrival (and only the arrival, when
  // moving straight between two notable ones).
  if (next === 'wedged') {
    pushEventItem(task, { eventKind: 'wedged', title: task.title }, at)
    recordHookFire(task, { trigger: 'wedged', by, at })
    return
  }
  if (next === 'landed') {
    pushEventItem(task, { eventKind: 'landed', title: task.title }, at)
    // Landing is terminal, so every armed wakeup is now dead weight — including
    // the await, which unlike an early revival has nothing left to come back to.
    // Left armed they resurrect a finished task to say it has nothing to do:
    // that is what every one of the seven observed spurious resumes actually
    // was. The daemon's wake-delivery table already answers a landed task with
    // "ack and drop" (docs/daemon-wakeups.md §Delivery) while the scheduler
    // happily launches one; this closes that asymmetry at the source.
    //
    // Here rather than at the land routes for the same reason the events are
    // here: `lander land`, `lander land <id>`, and the UI all funnel through
    // this one crossing, so no route can forget. Un-landing is unaffected — a
    // landed task revived by a message still works, it just no longer has a
    // stale trigger left to fire.
    delete task.scheduledFor
    delete task.waitingFor
    recordHookFire(task, { trigger: 'landed', by, at })
  } else if (prev === 'wedged' || prev === 'landed') {
    const eventKind = prev === 'wedged' ? 'unwedged' : 'unlanded'
    pushEventItem(task, { eventKind, title: task.title }, at)
    recordHookFire(task, { trigger: eventKind, by, at })
    // A revived task's own last act was `lander wedge`/`lander land`, and its
    // resumed session remembers that and nothing else — so left alone it reports
    // itself as still wedged/landed on the next turn. Stamp the crossing here,
    // for the same reason the events are stamped here: every revival route comes
    // through this one funnel, so no route can forget it. ONE-SHOT — the next
    // start-run carries it into the prompt and the queue drain that launched
    // that run clears it (see driveTask), so it can never ride a second turn.
    //
    // Merged rather than assigned: the cleared-timer half of the marker is
    // stamped separately by the /messages endpoint — riding↔resting is not a
    // crossing, so a resting task can't ride this funnel at all — and the two
    // halves co-occur (a wedged task can hold a retry wakeup), so neither may
    // clobber the other.
    task.revived = { ...task.revived, from: prev }
  }
  withdrawOpenAsks(task)
}

// A task's provider thread state (its resumable session id and the recorded
// per-turn context baseline) now lives inside `flowState`, alongside whatever
// else a flow persists — thread identity is just the first thing every driver
// happens to keep. Routing every server read/write through these accessors is
// what made moving the storage a change to four function bodies rather than to
// every call site.
//
// Reads are a union, new location first, and that fallback is permanent rather
// than transitional: a task whose session predates this flip keeps its id at the
// top level forever. Nothing migrates it — reduceRunWs's set-once guard means an
// adapter turn never rewrites an id it already has — so the union is what keeps
// those conversations resumable. Writes go only to the new location, so a task
// converts the first time it writes.
//
// Codex has no separate thread storage: it rides the same `sessionId` slot, so
// this one accessor family covers both providers.
type ThreadStateTask = {
  sessionId?: string
  turnContext?: string
  flowState?: Record<string, unknown>
}

function threadValue(
  task: ThreadStateTask,
  key: 'sessionId' | 'turnContext',
): string | undefined {
  const fromFlowState = task.flowState?.[key]
  if (typeof fromFlowState === 'string') return fromFlowState
  return task[key]
}

export function taskSessionId(task: ThreadStateTask): string | undefined {
  return threadValue(task, 'sessionId')
}
export function setTaskSessionId(task: ThreadStateTask, id: string): void {
  ;(task.flowState ??= {}).sessionId = id
}
export function taskTurnContext(task: ThreadStateTask): string | undefined {
  return threadValue(task, 'turnContext')
}
export function setTaskTurnContext(task: ThreadStateTask, ctx: string): void {
  ;(task.flowState ??= {}).turnContext = ctx
}
// Clear a task's provider thread (session + context baseline), so its next turn
// mints a fresh session and receives the full context block. Clears BOTH
// locations: a pre-flip task still carries the legacy fields, and leaving them
// would let the union read resurrect the very session the seal was meant to end.
export function clearTaskThread(task: ThreadStateTask): void {
  delete task.sessionId
  delete task.turnContext
  if (task.flowState) {
    delete task.flowState.sessionId
    delete task.flowState.turnContext
  }
}

// Seal a task's assistant session so its next turn mints a fresh provider session,
// and record the 'relaunched' divider event. This is the heart of `lander
// relaunch`: the daemon starts a new provider session whenever it's handed a
// turn with no `sessionId` (it resumes the same one otherwise), so deleting the
// field is all it takes — the new session is minted lazily on the next turn that
// drains a queued message, never pre-allocated. The old session's still-streaming
// turn emits no session announcement, so nothing races this clear for the
// top-level field (see reduceRunWs's set-once `if (!t.sessionId)`).
//
// It does NOT follow that nothing races the flowState blob: a still-running turn
// flushes its own state after this seal, and a buffered patch replayed on
// reconnect can restore individual keys onto the blob just deleted. Anything a
// flow keys off flowState must therefore tolerate a key outliving the thread it
// described — which is why codex's deliver-once gate reads `!sessionId ||` and
// not the delivery record alone (daemon/task-management.ts).
//
// Touches only session + event state; the caller owns the message/queue/status
// for the next turn.
export function sealForRelaunch(
  task: {
    sessionId?: string
    turnContext?: string
    flowState?: Record<string, unknown>
    flowStateRev?: number
    title: string
    items?: Item[]
  },
  at: string,
): void {
  // Clear the provider thread (session + the context baseline that belongs to it,
  // so the fresh session's first turn gets the full dynamic context block again)
  // through the accessor seam.
  clearTaskThread(task)
  // Relaunch = a fresh session with no memory, so clear the flow's durable state
  // too (flow-inversion.md: "relaunch seal = clear the blob"), generalizing the
  // session/context clear above. Inert in step 1 — no flow writes flowState yet.
  delete task.flowState
  delete task.flowStateRev
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
    pendingHooks?: PendingHook[]
    hookFireSeq?: number
  },
  message: string,
  at: string,
  by: string,
  repeat?: RepeatSpec,
): void {
  recordStatusTransition(
    task,
    'riding',
    new Date(Date.parse(at) - 1).toISOString(),
    by,
  )
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
    pendingHooks?: PendingHook[]
    hookFireSeq?: number
  },
  opts: { defer: boolean; resetsAt?: string; now: string; by: string },
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
    recordStatusTransition(
      task,
      'riding',
      new Date(Date.parse(now) - 1).toISOString(),
      opts.by,
    )
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
  const isPrompt = (it: Item) =>
    it.kind === 'message' && (it.role === 'user' || it.role === 'hook')
  let i = items.length - 1
  // Skip the trailing assistant turn (the last ride's items) and any events.
  while (i >= 0 && !isPrompt(items[i])) i--
  const prompts: string[] = []
  // The boundary is every prompt item, but only the USER ones are re-sent. A
  // hook's nudge must not come back as the user's words on a retry — and it must
  // not be walked past either, or a turn a hook drove would stash the *previous*
  // human instruction and re-run work the task already finished. A nudge-only
  // turn therefore yields nothing, which applyRetryRecovery turns into the
  // generic "try again" — the right recovery for a turn nobody typed.
  while (i >= 0 && isPrompt(items[i])) {
    const it = items[i] as MessageItem
    if (it.role === 'user') prompts.unshift(it.text)
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
    // Prompt items, not user items: a nudge carries no attachments but it does
    // occupy a queue slot, so counting only user items would walk past it and
    // attribute an older message's files to the hook's turn.
    if (it.kind === 'message' && (it.role === 'user' || it.role === 'hook')) {
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

// Deliver a drained batch into a ride: stamp `deliveredIn` on this batch's trailing
// user items and move the freshly-delivered ones to the tail of the item log.
//
// A user message is appended to `items[]` at its *enqueue* slot (pushUserItem, when
// it's sent). One typed mid-ride therefore lands ahead of that ride's own items, and
// buildTimeline — which trusts array order and pins a ride bubble at its first item —
// renders it before the reply it was actually delivered after. Moving it to the tail
// here, just before the ride opens, makes its stored position its delivery position,
// so array order becomes delivery order.
//
// The move set is the trailing `batchLen` user items (this delivery's own messages,
// NOT the whole history) minus any that already carry `deliveredIn`. The trailing-N
// scope keeps migrated/historical items — convertUser never stamps them — and any
// unqueued orphan opening off the move; the `!deliveredIn` filter then excludes
// re-delivery entries in that window (retry resend, recoverQueues opening-replay
// re-queue an already-delivered item), leaving them in their correct historical slot.
// `moving` MUST be computed before the stamp loop — stamping first would empty it.
export function deliverQueuedBatch(
  task: { items?: Item[] },
  batchLen: number,
  runId: string,
): void {
  const window = promptItems(task).slice(-batchLen)
  const moving = window.filter((u) => !u.deliveredIn)
  for (const u of window) u.deliveredIn = runId
  if (moving.length && task.items) {
    const movingSet = new Set<Item>(moving)
    task.items = task.items.filter((it) => !movingSet.has(it))
    for (const u of moving) task.items.push(u)
  }
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
