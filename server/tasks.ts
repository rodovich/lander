// Task message/event types and the small pure helpers over them: the public
// (token-stripped) projection, the "latest completed update" timestamp behind
// the unseen dot, the lifecycle-event recorder, and the in-flight-message
// accessors. Typed structurally so they can be unit-tested without the full
// server Task type (index.ts passes its Task, which satisfies these shapes).

import path from 'node:path'
import type { AgentKind } from './agent'
import type { Step, Usage } from '../shared/stream'
import type { Attachment } from './attachments'
import type { RevivedMarker, ScheduledRide } from './protocol'
import type { ContextAction, ContextDetails } from '../shared/context'
// The one value we import (the rest of this module's imports are types):
// recordStatusTransition settles open asks on the crossing. asks.ts imports only
// types from here, so the runtime edge stays one-way — this module → asks.ts.
import { withdrawOpenAsks, type Ask, type AskForm } from './asks'
import { LEGACY_FLOW, flowCaps, type FlowCaps } from './flows'
import { isUnread, type ReadableTask } from '../shared/readMarker'
import { openRide } from '../shared/timeline'
import { blockquote } from '../shared/conversationText'

export { openRide }

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
// paced churn during and after a run isn't interesting, so it isn't recorded.
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
    // (the actual divider) — the same pattern a deferred `ride` shows as a
    // 'scheduled' then a 'launched'.
    | 'relaunched'
    // A wakeup the task armed came due — a time, awaited tasks landing — or the
    // server found its turn cut off by a restart: lander told it so, in the
    // message the event carries. Not a 'launched': the task is only queued to
    // ride, which no daemon may yet have taken up.
    | 'notified'
  // The task's title at the time of the event. Absent on a launch/schedule event
  // until the first generated name amends it, and on events saved before titles
  // were captured.
  title?: string
  // 'scheduled' (and an armed 'relaunched') only: the date/time the task is set
  // to launch/relaunch, shown beside the verb (the event's own createdAt is when
  // it was scheduled).
  scheduledFor?: string
  // 'awaiting' only: the tasks this one is waiting on (id + title as of the
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
  compacting?: true
  startedAt: string
  // The flow this turn was for. A task can change flows at a relaunch, so the
  // task's current flow doesn't say whose an earlier ride was. Absent only on a
  // task that has never switched (see switchTaskFlow), whose rides are all its
  // flow's.
  flow?: string
  // Absent while the ride is open. Stamped by closeRide when the run finishes.
  endedAt?: string
  outcome?: 'done' | 'interrupted' | 'error'
  // The turn's token usage, moved off the message onto the ride at close time.
  usage?: Usage
  // How long the run worked, as the daemon measured it (DoneMessage.durationMs).
  // Stored rather than derived from `startedAt`/`endedAt`, which answer a
  // different question: those bracket the ride as the *server* saw it, so their
  // difference also counts the hand-off, the idle window a watchdog kill waited
  // out, and — when a ride is closed by boot recovery instead of by a done — the
  // whole span the server was down. Absent on any ride whose run never reported
  // a done, which is the best-effort silence `usage.costUsd` already has.
  durationMs?: number
  // Set once the flow reports that the provider recorded this turn's user
  // message in its session (UpdateMessage.committed).
  committed?: true
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
  // The path of the hook whose own action caused this fire, when one did.
  // Dispatch skips that hook for this entry and no other, which is what lets a
  // hook-initiated landing chain into cleanup or self-review — the chaining the
  // design wants — while the hook that landed the target is not woken by its own
  // landing.
  //
  // It covers the status crossings only. `ride-ended` fires are minted by
  // recordRideEnded from applyDone and the crashed branch, where no route and no
  // principal are in scope, so a nudge → ride → ride-ended cycle cannot be
  // labeled here; that loop is bounded by the action bound instead, which is
  // what hooks.md §8 says bounds it.
  byHook?: string
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
  kind: 'nudge' | 'land' | 'launch'
  at: string
  // What a launch produced, so a retry that is deduped can answer the body with
  // the task the original created rather than with nothing. Absent for the verbs
  // that act on the target itself, which produce no id.
  taskId?: string
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

// The action already recorded for this (hook, fire, key), if there is one.
//
// Checked by a route BEFORE its refusals, not only inside acceptHookAction: an
// action a retry re-presents was already delivered, so the honest answer is
// "done" whatever the target's state has become since. Refusing it as `stale`
// would put a note on the timeline saying a finding was dropped when it was in
// fact sent, and would leave the host's ordinal unadvanced — so the next action
// of that run would re-present a key already spent.
export function hookActionTaken(
  task: { hookActions?: HookAction[] },
  action: Pick<HookAction, 'hook' | 'fireId' | 'key'>,
): HookAction | undefined {
  return (task.hookActions ?? []).find(
    (a) => a.hook === action.hook && a.fireId === action.fireId && a.key === action.key,
  )
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

// Undo an accepted action, for the one caller that can find out afterwards that
// it did not happen: a launch whose task file failed to write.
//
// Without it the record names a task that does not exist, and `hookActionTaken`
// runs ahead of every refusal — so every retry of that fire is answered "already
// done" with an id that resolves to nothing, permanently. Deleting also refunds
// the bounded slot, which is right: the bound exists to stop a hook acting
// repeatedly ON A TARGET, and an action that created nothing is not an action to
// bound. A body looping on failed creates is bounded by its own timeout and
// produces no effect while it does.
export function dropHookAction(
  task: { hookActions?: HookAction[] },
  action: Pick<HookAction, 'hook' | 'fireId' | 'key'>,
): void {
  const actions = task.hookActions
  if (!actions) return
  const at = actions.findIndex(
    (a) => a.hook === action.hook && a.fireId === action.fireId && a.key === action.key,
  )
  if (at >= 0) actions.splice(at, 1)
}

// The fire an action is being taken for, if it is still the fire that was
// recorded — otherwise undefined, and the action must be refused.
//
// A fire can be held: by a daemon drain, by the concurrency cap, by a dispatch
// timeout that leaves the body alive. It can therefore outlive the state it was
// recorded against, and acting then is how a supervision nudge becomes an
// accidental reopen of a task that landed in the meantime, carrying a finding
// about work two segments old.
//
// Three ways a fire goes stale, and the first is the cheapest signal there is:
//
//   1. **It is no longer pending.** Entries are cleared only when every hook has
//      reported, so a fire that has left the list is a fire that finished — and
//      this presentation is a straggler.
//   2. **The target crossed a notable status since.** Landing is the dangerous
//      one (the nudge would reopen it), but every crossing means the task moved
//      somewhere the finding did not anticipate.
//   3. **A human said something since.** A user message opens a new segment, so
//      the target is working on a newer instruction and a finding about the
//      previous one is exactly the "two segments old" case.
//
// Checked here rather than in each body's own guards: a body that forgets is the
// failure mode this exists to prevent, and the platform holds the fire.
export function freshHookFire(
  task: { pendingHooks?: PendingHook[]; items?: Item[] },
  fireId: string,
): PendingHook | undefined {
  const entry = (task.pendingHooks ?? []).find((f) => f.id === fireId)
  if (!entry) return undefined
  const since = entry.at
  for (const it of task.items ?? []) {
    if (it.at <= since) continue
    if (it.kind === 'event' && CROSSINGS.has(it.eventKind)) return undefined
    if (it.kind === 'message' && it.role === 'user') return undefined
  }
  return entry
}

const CROSSINGS = new Set<TaskEvent['kind']>([
  'landed',
  'unlanded',
  'wedged',
  'unwedged',
])

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

// Whether a task is done with the checkout the daemon manages for it: landed or
// archived, with no run or open ride, and — for a landed task — no hook fires
// left to dispatch, since a `landed` hook reads the task's checkout. (Archive
// drops pending fires, so an archived task waits on none.) The caller also
// rules out a live drainer, which only it can see.
export function checkoutReleasable(
  task: {
    status: string
    runId?: string
    rides?: Ride[]
    pendingHooks?: PendingHook[]
  },
  { archived }: { archived: boolean },
): boolean {
  if (task.runId || openRide(task)) return false
  if (archived) return true
  return task.status === 'landed' && !task.pendingHooks?.length
}

// Open a ride for a run being handed to the daemon: push `{ id, startedAt }`. The
// id is the daemon runId, so a reattach/close can find the ride by the run it
// tracks. One ride per run.
export function startRide(
  task: { rides?: Ride[]; flow?: string; agent?: string },
  id: string,
  at: string,
): void {
  ;(task.rides ??= []).push({ id, startedAt: at, flow: taskFlow(task) })
}

// No-ops when no ride is open, so a caller tidying up after a run (the drainer's
// stray-ride sweep, a late done) needn't check whether another path closed it.
export function closeRide(
  task: { rides?: Ride[] },
  outcome: Ride['outcome'],
  at: string,
): void {
  const ride = openRide(task)
  if (!ride) return
  ride.endedAt = at
  delete ride.compacting
  ride.outcome = outcome
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

export type HookSender = { hook: string; path: string; fireId: string }

// A task that put a message in a task's conversation, and how: its `lander
// launch` opening message, a `lander send`, or the `--notify` wake carrying its
// closing message to another task — or its `lander relaunch` brief to its own
// next session. Named by id alone, because none of them may cross a project.
export type TaskSender = {
  task: string
  via: 'launch' | 'send' | 'notify' | 'relaunch'
}

// Lander itself, telling a task why it is awake: the time it set came, the
// tasks it awaited landed, or a restart cut off its previous ride.
export type LanderSender = { lander: 'time' | 'await' | 'restart' }

// A prompt item as the agent receives it: a message from another task with its
// sender named ahead of its words. Composed whenever the item is queued for a
// turn — its first delivery, a retry, a replay after a restart — so the record
// holds the words alone and `from` says who sent them. Plain text, so one
// wording serves every provider; the queue is joined into one turn before any
// flow sees it. Lander's own notifications already say who they are from.
export function attributedPrompt(m: {
  text: string
  from?: HookSender | TaskSender | LanderSender
}): string {
  if (!m.from || !('task' in m.from)) return m.text
  const { task, via } = m.from
  if (via === 'launch') return `Launched by ${task}:\n\n${m.text}`
  if (via === 'send') return `From ${task}:\n\n${m.text}`
  // A relaunch brief is the task's own words to its next session, which knows
  // from its prompt that a relaunch is how it starts; there is no one to name.
  if (via === 'relaunch') return m.text
  // A `--notify` wake says "finished a turn" rather than "is done": a clean
  // turn-end is not a claim that the work is complete, and the launcher has to
  // decide that for itself.
  return m.text ? `${task} finished a turn:\n\n${m.text}` : `${task} finished a turn.`
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
  // Who spoke, when it was not the task's human: the hook on a `hook` message,
  // or on a `user` message the task that put it there, or lander telling the
  // task why it woke. Carried rather than left to be parsed out of the
  // attributed text: `path` is a hook's identity, and a body asking "did I
  // already nudge this span" must not have to regex a display prefix.
  from?: HookSender | TaskSender | LanderSender
  attachments?: Attachment[]
  // Set on a user message once a queued batch delivers it: the ride that consumed
  // it, making the batching visible. Absent on converted history.
  deliveredIn?: string
  // Set on a message another task sent with `lander send --notify`: wake that
  // task (`from`) with this task's closing message once a turn this message
  // reached ends cleanly. Armed on delivery rather than on send
  // (deliverQueuedBatch), so a message queued behind a turn already in progress
  // is answered by the turn that reads it, not the one that was running.
  notify?: true
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
  // The id of the user item this event delivered — a relaunch's brief, or the
  // notification on a 'notified' (always present there) — which the timeline
  // tells inside the event's note rather than as the user speaking. Set by
  // pushEventPrompt in the mutation that writes both.
  message?: string
}

// A task-management action attributed to another task. Unlike EventItem, this
// describes what the containing task did to a project-qualified target, not a
// lifecycle transition of the containing task itself.
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

export type TaskActionInput =
  | { action: 'launch'; target: TaskActionRef; trigger?: TaskActionTrigger }
  | {
      action: 'message'
      target: TaskActionRef
      trigger?: TaskActionTrigger
      // What was sent, so the actor's own timeline reads as an account of the
      // exchange rather than a bare "messaged task". A clamped echo — the
      // delivered text lives in full on the recipient.
      text?: string
    }
  | { action: 'status'; target: TaskActionRef; toStatus: string }

export type TaskActionItem = ItemCommon &
  { kind: 'task-action'
    // The actor's ride at the moment it acted — the turn this was done during.
    // Absent when nothing was in flight (a detached child outliving the turn
    // that spawned it), which is what leaves the note standing on its own.
    //
    // It carries `ride`, never `rideId`, for the same reason HookItem does:
    // buildTimeline routes anything with a `rideId` into the ride's item log
    // before it looks at the kind, and this is an account of what the turn did
    // to another task, not a step of the turn. The client anchors it into the
    // turn at render time and the ride's own items stay untouched.
    ride?: string
  } & TaskActionInput

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
  opts: {
    attachments?: Attachment[]
    deliveredIn?: string
    from?: TaskSender | LanderSender
    notify?: boolean
  } = {},
): MessageItem {
  const item: MessageItem = {
    id: nextItemId(task, at),
    at,
    kind: 'message',
    role: 'user',
    text,
    ...(opts.from ? { from: opts.from } : {}),
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    ...(opts.deliveredIn ? { deliveredIn: opts.deliveredIn } : {}),
    ...(opts.notify ? { notify: true as const } : {}),
  }
  ;(task.items ??= []).push(item)
  return item
}

// Append the prompt a lifecycle event delivers, and point the event at it, so the
// two are told as one note. Written in the event's own mutation, so the pairing
// is recorded rather than inferred from adjacency, which a queued message's move
// to the tail on delivery would break (deliverQueuedBatch).
export function pushEventPrompt(
  task: { items?: Item[] },
  event: EventItem,
  text: string,
  at: string,
  from: TaskSender | LanderSender,
): MessageItem {
  const item = pushUserItem(task, text, at, { from })
  event.message = item.id
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

// Append an attributed task-management action, stamped with the actor's open
// ride so the client can anchor it inside the turn that took it. Stored outside
// the ride's item log either way (see TaskActionItem's `ride`). The caller
// deliberately decides whether the mutation warrants updatedAt/unread changes;
// this builder only adds the semantic timeline row.
export function pushTaskActionItem(
  task: { items?: Item[]; rides?: Ride[] },
  action: TaskActionInput,
  at: string,
): TaskActionItem {
  const ride = openRide(task)
  const item = {
    id: nextItemId(task, at),
    at,
    kind: 'task-action',
    ...(ride ? { ride: ride.id } : {}),
    ...action,
  } as TaskActionItem
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
  from: HookSender,
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
// would resurface a paced task to the top of the list for a finding that, in a
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
// finalText updates (applyUpdate) and attachment refs
// (recordAttachmentOnMessage).
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

// Open and close an error ride for a turn that failed before it could start one.
// runTurn's undispatched turns (no daemon serving the project, a flow the primary
// has not announced) pass no `text`: no agent ran to say anything, so their
// retry ask is the record and the ride shows nothing. Only runTurn's
// unreadable-task-file path passes `text`, its read error.
//
// This is a third place a ride transitions to closed with an outcome, alongside
// applyDone and the platform-kill branch, so it records the ride-ended fire too.
// Those undispatched turns are exactly the "wedged for mechanical reasons" case
// supervision exists for, so omitting them would leave the trigger blind to its
// own motivating example.
export function recordUndispatchedRide(
  task: {
    items?: Item[]
    rides?: Ride[]
    pendingHooks?: PendingHook[]
    hookFireSeq?: number
  },
  at: string,
  text?: string,
): void {
  const id = `ride-${Math.floor(Date.parse(at) || 0).toString(36)}-e${
    task.rides?.length ?? 0
  }`
  startRide(task, id, at)
  const ride = openRide(task) as Ride
  if (text) pushFlowItem(task, ride.id, text, at)
  recordRideEnded(task, ride, 'error', at)
  closeRide(task, 'error', at)
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
  // The flow a relaunch moves the task onto when it fires (`relaunch --flow`).
  flow?: string
  repeat?: RepeatSpec
  // Attachment refs sent with a deferred `lander send --attach --date/--await`,
  // carried until delivery when they land on the appended user message (like an
  // immediate send). Absent when the deferred message had none.
  attachments?: Attachment[]
  // The task that sent it, stamped on the delivered message and named to the
  // agent ahead of `text` (attributedPrompt). Absent for the human's own sends
  // and a task's relaunch of itself.
  from?: TaskSender
  // `lander send --notify`, carried onto the delivered message (see
  // MessageItem.notify).
  notify?: true
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

// Move a task onto another flow, as a relaunch into it does. Rides recorded
// before rides carried their flow are stamped with the old one. What the task
// holds for the old flow is dropped: its legacy `agent`, its allow rules (that
// flow's permission syntax), its flowConfig (that flow's opaque config) and its
// recorded cwd (Claude's shell, which Codex and agy would launch in).
export function switchTaskFlow(
  task: {
    flow?: string
    agent?: string
    allow?: string[]
    flowConfig?: Record<string, unknown>
    cwd?: string
    rides?: Ride[]
  },
  flow: string,
): void {
  const old = taskFlow(task)
  if (flow === old) return
  for (const ride of task.rides ?? []) ride.flow ??= old
  task.flow = flow
  delete task.agent
  delete task.allow
  delete task.flowConfig
  delete task.cwd
}

// Grant-capability flags served on the public task so the UI stops branching on
// the provider: `task` = task-scope allow rules are honored, `project` =
// project-scope grants are supported. Now sourced from the flow's ANNOUNCED
// meta.capabilities (see server/flows.ts) rather than a compiled switch on the
// agent kind — which is what lets a flow the server has never been compiled
// against describe its own capabilities.
export type GrantCaps = { task: boolean; project: boolean }

export function publicTaskStatus(task: {
  status?: string
  rides?: Ride[]
  runId?: unknown
}): string | undefined {
  if (typeof task.status !== 'string') return undefined
  if (task.status !== 'riding') return task.status
  return openRide(task) || task.runId != null ? 'riding' : 'paced'
}

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
  | 'sealedRunId'
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
    sealedRunId: _sr,
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
    // Tasks saved while read-only tasks existed still carry the edit flag. No
    // code reads it, and served as `false` it would misreport the task's access.
    allowEdits: _ae,
    queued,
    ...rest
  } = task as T & {
    token?: unknown
    runId?: unknown
    runCursor?: unknown
    sealedRunId?: unknown
    retry?: unknown
    flowState?: unknown
    flowStateRev?: unknown
    hookFireSeq?: unknown
    hookActionsResetAt?: unknown
    hookActions?: unknown
    allowEdits?: unknown
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
  // with no live run it is idle, served as `paced`, which the UI decorates with
  // any `scheduledFor`/`waitingFor`. `wedged`/`landed` serve as stored.
  const status = publicTaskStatus({
    ...(task as { status?: string; rides?: Ride[] }),
    runId: _r,
  })
  if (status !== undefined) restT.status = status

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
  | 'sealedRunId'
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
// `paced`. So the full projection runs FIRST and the arrays come off its
// *output* — dropping them on the way in would demote every riding task to
// paced, emptying the UI's riding section and killing the row spinner.
//
// `scheduledMessages` rides through `publicTask` carrying each deferred
// message's full text, so it is projected too, down to the fields the list
// consumers read (`bin/task-metadata.js`). The `.map` is index-preserving —
// entry `[0]` is read positionally — so a message with none of these fields
// still occupies its slot.
export function taskSummary<T extends object>(task: T, opts?: { caps?: FlowCaps }) {
  const full = publicTask(task, opts)
  const unread = isUnread(full as ReadableTask)
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
    ...(unread ? { unread: true } : {}),
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

// The one-time move from `seenAt`, a "caught up to the latest update" boolean
// in timestamp's clothing, to `readThrough`, the point in the conversation the
// viewer has read up to (the client's readMarker.ts owns what it means). A task
// that read as caught up stays so: it's read through now, which covers every
// entry it has. One that read as unread is read through the human's last
// message, so what the task did after it is what reads as new. Idempotent: a
// task already carrying `readThrough` only sheds a stray `seenAt`.
export function migrateSeenAt(
  task: { items?: Item[]; rides?: Ride[]; seenAt?: string; readThrough?: string },
  now: string,
): void {
  if (task.readThrough === undefined) {
    const seen = task.seenAt
    if (seen != null && legacyLatestUpdateAt(task) > seen) {
      let lastOwn = ''
      for (const it of task.items ?? [])
        if (it.kind === 'message' && it.role === 'user' && !it.from && it.at > lastOwn)
          lastOwn = it.at
      task.readThrough = lastOwn
    } else {
      task.readThrough = now
    }
  }
  delete task.seenAt
}

export function needsSeenAtMigration(task: { seenAt?: string; readThrough?: string }): boolean {
  return task.readThrough === undefined || 'seenAt' in task
}

// The update `seenAt` was compared against, exactly as the client computed it
// before `readThrough` replaced it — kept only so the migration reads each
// task's unread state as the UI last showed it: the newest of the user and hook
// messages, lifecycle events and hook reports, and the settled rides' *start*
// times. The open ride counts for nothing.
function legacyLatestUpdateAt(task: { items?: Item[]; rides?: Ride[] }): string {
  const open = openRide(task)
  let latest = ''
  for (const it of task.items ?? []) {
    const counts =
      (it.kind === 'message' && (it.role === 'user' || it.role === 'hook')) ||
      it.kind === 'event' ||
      it.kind === 'hook'
    if (counts && it.at > latest) latest = it.at
  }
  for (const r of task.rides ?? []) {
    if (open && r.id === open.id) continue
    if (r.startedAt > latest) latest = r.startedAt
  }
  return latest
}

// Record a crossing into or out of a "notable" status — "wedged" (the task
// needs the user) or the terminal "landed" — as a timeline event, so the UI can
// show it inline among the messages. Entering a notable status records it
// ("wedged"/"landed"); leaving one for an un-notable status (riding/paced)
// records the inverse ("unwedged"/"unlanded"). A no-op for moves between two
// quiet statuses (e.g. riding↔paced) or that don't change status. Moving
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
// Note what this deliberately does NOT cover: a riding↔paced move isn't a
// crossing (both store as `riding`, so this returns early), which is exactly
// right for an advisory `lander ask` — it never wedged, so waiting with the
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
  // The hook whose action caused this crossing, when one did. Rides onto the
  // fire so dispatch can skip that hook and only that hook.
  byHook?: string,
): void {
  const prev = task.status
  if (prev === next) return
  const cause = byHook ? { byHook } : {}
  // Entering a notable status records the arrival (and only the arrival, when
  // moving straight between two notable ones).
  if (next === 'wedged') {
    pushEventItem(task, { eventKind: 'wedged', title: task.title }, at)
    recordHookFire(task, { trigger: 'wedged', by, at, ...cause })
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
    recordHookFire(task, { trigger: 'landed', by, at, ...cause })
  } else if (prev === 'wedged' || prev === 'landed') {
    const eventKind = prev === 'wedged' ? 'unwedged' : 'unlanded'
    pushEventItem(task, { eventKind, title: task.title }, at)
    recordHookFire(task, { trigger: eventKind, by, at, ...cause })
    // A revived task's own last act was `lander wedge`/`lander land`, and its
    // resumed session remembers that and nothing else — so left alone it reports
    // itself as still wedged/landed on the next turn. Stamp the crossing here,
    // for the same reason the events are stamped here: every revival route comes
    // through this one funnel, so no route can forget it. ONE-SHOT — the next
    // start-run carries it into the prompt and the queue drain that launched
    // that run clears it (see driveTask), so it can never ride a second turn.
    //
    // Merged rather than assigned: the cleared-timer half of the marker is
    // stamped separately by the /messages endpoint — riding↔paced is not a
    // crossing, so a paced task can't ride this funnel at all — and the two
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
// turn with no `sessionId` (it resumes the same one otherwise), so the new
// session is minted lazily on the next turn that drains a queued message, never
// pre-allocated.
//
// A seal usually lands mid-turn — a task relaunching itself — and that turn keeps
// streaming afterward. Its later writes to the thread, and the ones the daemon
// replays when the server reconnects, describe the session just sealed, so the
// run is marked `sealedRunId`: reduceRunWs drops them, and its failure raises no
// retry ask over the turn the relaunch queued.
//
// `flow`, when given, is the flow the fresh session runs under.
//
// The caller owns the message/queue/status for the next turn, and links the
// returned divider to the message it appends (pushEventPrompt).
export function sealForRelaunch(
  task: {
    sessionId?: string
    turnContext?: string
    flowState?: Record<string, unknown>
    flowStateRev?: number
    runId?: string
    sealedRunId?: string
    flow?: string
    agent?: string
    allow?: string[]
    flowConfig?: Record<string, unknown>
    cwd?: string
    rides?: Ride[]
    title: string
    items?: Item[]
  },
  at: string,
  flow?: string,
): EventItem {
  if (task.runId) task.sealedRunId = task.runId
  if (flow) switchTaskFlow(task, flow)
  // Clear the provider thread (session + the context baseline that belongs to it,
  // so the fresh session's first turn gets the full dynamic context block again)
  // through the accessor seam.
  clearTaskThread(task)
  // Relaunch = a fresh session with no memory, so clear the flow's durable state
  // too (flow-inversion.md: "relaunch seal = clear the blob"), generalizing the
  // session/context clear above.
  delete task.flowState
  delete task.flowStateRev
  return pushEventItem(task, { eventKind: 'relaunched', title: task.title }, at)
}

export function clearRunPointers(task: {
  runId?: string
  runCursor?: number
  sealedRunId?: string
}): void {
  delete task.runId
  delete task.runCursor
  delete task.sealedRunId
}

export function isSealedRun(
  task: { sealedRunId?: string },
  runId: string | undefined,
): boolean {
  return runId !== undefined && task.sealedRunId === runId
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
    id: string
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
  { repeat, flow }: { repeat?: RepeatSpec; flow?: string } = {},
): void {
  recordStatusTransition(
    task,
    'riding',
    new Date(Date.parse(at) - 1).toISOString(),
    by,
  )
  const divider = sealForRelaunch(task, at, flow)
  const item = pushEventPrompt(task, divider, message, at, {
    task: task.id,
    via: 'relaunch',
  })
  ;(task.queued ??= []).push(attributedPrompt(item))
  task.status = 'riding'
  task.updatedAt = at
  delete task.retry
  // A repeating relaunch (`--interval`) arms its next occurrence off this
  // (immediate) delivery; each later occurrence re-arms itself in applyDueMessages
  // when it in turn delivers. Nothing is armed once the series' bound is reached.
  if (repeat) {
    const next = nextRepeatMessage({ text: message, repeat, flow }, at)
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
  entry: { text: string; repeat?: RepeatSpec; flow?: string },
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
    flow: entry.flow,
    repeat: {
      interval: r.interval,
      ...(r.remaining != null ? { remaining: r.remaining - 1 } : {}),
      ...(r.until != null ? { until: r.until } : {}),
    },
  }
}

// Append a batch of now-due scheduled messages and queue them for the session —
// the shared tail of an immediate and a scheduled delivery. If any due entry is
// a relaunch (`lander relaunch --date/--time/--await`), seal the session and lead
// with the relaunch text so the fresh session reads it first; ordinary due
// messages keep their order and follow. The caller has already split due from
// not-yet-due and recorded the riding transition; this only mutates the
// session/message/queue state.
export function applyDueMessages(
  task: {
    id: string
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
  // Each relaunch brief gets its own divider to be told under. Several due in
  // one sweep seal an already-sealed session, which is harmless.
  for (const m of relaunch) {
    const item = pushEventPrompt(task, sealForRelaunch(task, at, m.flow), m.text, at, {
      task: task.id,
      via: 'relaunch',
    })
    ;(task.queued ??= []).push(attributedPrompt(item))
  }
  for (const m of rest) {
    pushUserItem(task, m.text, at, {
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ...(m.from ? { from: m.from } : {}),
      notify: m.notify,
    })
    ;(task.queued ??= []).push(attributedPrompt(m))
  }
  // Re-arm the next occurrence of any repeating relaunch (`--interval`) that just
  // delivered, measured off this delivery — the deferred analog of applyRelaunch's
  // arming. Nothing is armed once the series' count/until bound is reached.
  for (const m of relaunch) {
    const next = nextRepeatMessage(m, at)
    if (next) (task.scheduledMessages ??= []).push(next)
  }
}

// The notification a wakeup drives into a task that has already run, which
// names the condition that fired because that is the one thing the woken
// session cannot work out for itself: it remembers only its own last act. Each
// says what happened, never what the task is doing about it — it is queued to
// ride, which no daemon may yet have taken up.
//
// The time arm states the date, which the session matches against the time
// `lander ride` printed when it armed; the moment is not the condition for the
// others.
//
// Awaited tasks go in as bare ids: the client renders each as a chip carrying
// the task's title as it stands when the conversation is read, so naming them
// here would both duplicate that and freeze a title that can still change.
export function wakeupNotification(
  at: string,
  landed?: string[],
): { text: string; from: LanderSender } {
  if (!landed?.length)
    return {
      text: `Current date: ${displayTime(at)}`,
      from: { lander: 'time' },
    }
  const noun = landed.length > 1 ? 'Tasks' : 'Task'
  return { text: `${noun} landed: ${landed.join(', ')}`, from: { lander: 'await' } }
}

// How a scheduled time is shown to the agent: the date its "Current date: …"
// notification carries, and every message that names that time.
export function displayTime(iso: string): string {
  return new Date(iso).toLocaleString()
}

// The ride a task still has scheduled, for the turn about to start to be reminded
// of.
export function scheduledRideOf(task: {
  scheduledFor?: string
  waitingFor?: string[]
}): ScheduledRide | undefined {
  if (!task.scheduledFor && !task.waitingFor?.length) return undefined
  return {
    ...(task.scheduledFor ? { at: displayTime(task.scheduledFor) } : {}),
    ...(task.waitingFor?.length ? { awaiting: task.waitingFor } : {}),
  }
}

// Whether what a task has scheduled is a ride it scheduled for itself, rather
// than a trigger holding back work already queued for it — a deferred launch
// that has not run yet, or a wedged task's deferred retry or answer. Inferred
// from the task's state, since neither records which it is. A ride fires as
// lander's notification of the trigger; a held-back trigger fires by driving
// its queue, and a message that reaches the task drives it sooner, leaving the
// trigger nothing to do.
export function hasOwnScheduledRide(task: {
  status: string
  rides?: Ride[]
  queued?: string[]
  scheduledFor?: string
  waitingFor?: string[]
}): boolean {
  if (!task.scheduledFor && !task.waitingFor?.length) return false
  if (!task.rides?.length) return false
  return !(task.status === 'wedged' && task.queued?.length)
}

// The revival marker carries the cleared time, so the next turn can schedule it
// again in one step.
export function clearScheduledTime(task: {
  scheduledFor?: string
  revived?: RevivedMarker
}): void {
  if (!task.scheduledFor) return
  task.revived = { ...task.revived, waitingUntil: displayTime(task.scheduledFor) }
  delete task.scheduledFor
}

// The notification a restart drives into a task whose turn it cut off after
// the task had already replied once (recoverQueues).
export const INTERRUPTED_NOTIFICATION = {
  text: 'The previous ride was interrupted.',
  from: { lander: 'restart' },
} as const satisfies { text: string; from: LanderSender }

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
  entry: {
    text: string
    deliverAt?: string
    waitFor?: string[]
    repeat?: RepeatSpec
    flow?: string
  },
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

// The message a relaunch-and-retry (the retry ask's menu) hands the fresh
// session: what it can't know about the session it replaces, the task's opening
// message, the task's last finished reply, and the turn that failed, each quoted
// and capped. The rest is a `lander view` away. A failed turn that was itself a
// relaunch brief is handed on as it stands.
export function relaunchRetryBrief(task: {
  id: string
  items?: Item[]
  rides?: Ride[]
  retry?: { prompts: string[] }
}): string {
  const quote = (text: string) =>
    blockquote(text.length > 4000 ? `${text.slice(0, 4000)}…` : text)
  const failed = (task.retry?.prompts ?? []).filter((p) => p.trim()).join('\n\n')
  const last = userItems(task).at(-1)
  if (last?.from && 'via' in last.from && last.from.via === 'relaunch' && last.text === failed)
    return failed
  const first = userItems(task)[0]
  const opening = first && attributedPrompt(first)
  const reply = (task.rides ?? [])
    .filter((r) => r.outcome === 'done')
    .map((r) => lastFlowItem(task, r.id)?.text)
    .filter(Boolean)
    .at(-1)
  const parts = [
    "This task's previous session could not be continued, so this is a fresh one. " +
      'You have none of its tool results or reasoning: check anything it concluded ' +
      'before relying on it. Read the conversation so far with ' +
      `\`lander view ${task.id} --messages all --expand\`.`,
  ]
  if (opening && opening !== failed) parts.push(`The task began with:\n\n${quote(opening)}`)
  if (reply) parts.push(`The last reply the task finished was:\n\n${quote(reply)}`)
  parts.push(
    failed
      ? `Then came this, which the session could not answer:\n\n${quote(failed)}`
      : 'Its last turn failed; pick up where it left off.',
  )
  return parts.join('\n\n')
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
    if (it.role === 'user') prompts.unshift(attributedPrompt(it))
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
//
// A `send --notify` message arms its sender on its first delivery only: arming
// is consumed when it fires, so arming again on a re-delivery would wake the
// sender a second time.
export function deliverQueuedBatch(
  task: { items?: Item[]; notify?: NotifyArming },
  batchLen: number,
  runId: string,
): void {
  const window = promptItems(task).slice(-batchLen)
  const moving = window.filter((u) => !u.deliveredIn)
  for (const u of window) u.deliveredIn = runId
  for (const u of moving)
    if (u.notify && u.from && 'task' in u.from) armNotify(task, u.from.task)
  if (moving.length && task.items) {
    const movingSet = new Set<Item>(moving)
    task.items = task.items.filter((it) => !movingSet.has(it))
    for (const u of moving) task.items.push(u)
  }
}

// The tasks waiting to be woken once, when a task next finishes a turn cleanly:
// its launcher (`launch --notify`) and any task whose `send --notify` it has read.
// A bare id is the shape from before `send --notify`, when only the launcher
// could wait; a task armed then can still be on disk unfired.
export type NotifyArming = string | string[]

export function armNotify(task: { notify?: NotifyArming }, to: string): void {
  const targets = asList(task.notify)
  if (!targets.includes(to)) task.notify = [...targets, to]
}

// A fired notification waiting for the sweep to deliver it, naming the ride whose
// closing message it delivers.
export type PendingNotify = { to: string; at: string; rideId?: string }

// A task can hold one per waiter, and a drain that fires different waiters on
// different turns holds several turns' worth. A single object is the shape from
// before there could be several; one can still be on disk undelivered.
export type PendingNotifies = PendingNotify | PendingNotify[]

// Read a field kept in an older single-value shape (NotifyArming,
// PendingNotifies) as the list it became.
export function asList<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

// Record a published attachment on the flow item that produced it, so its chip
// renders under that turn. Appends rather than replacing by name: blobs are
// immutable, so two publishes of one name are two outputs, not one overwritten.
//
// An open ride with no item yet gets one opened, so a publish that precedes any
// prose begins the turn — a flow that writes its outputs before it speaks would
// otherwise have nowhere to put them. That branch has to precede the fall back to
// the last item overall, or a new turn's output files itself under a previous
// ride. Returning undefined means the task has never ridden, so there is no turn
// the ref could belong to.
export function recordAttachmentOnMessage(
  task: { items?: Item[]; rides?: Ride[] },
  attachment: Attachment,
  at: string,
): MessageItem | undefined {
  const ride = openRide(task)
  const host = ride
    ? (lastFlowItem(task, ride.id) ?? pushFlowItem(task, ride.id, '', at))
    : lastFlowItem(task)
  if (!host) return undefined
  ;(host.attachments ??= []).push(attachment)
  return host
}

// The shape a task's outputs had before they became attachments: a name→blob slot
// on the task, mirrored as a point-in-time ref on the message that published it.
// Declared here rather than imported because the migration below is the only code
// left that reads it.
type LegacyArtifact = {
  name: string
  id: string
  mime: string
  size: number
  createdAt: string
  updatedAt: string
}
type LegacyTask = { items?: Item[]; artifacts?: LegacyArtifact[] }
type LegacyItem = Item & { artifacts?: LegacyArtifact[] }

// Fold a task's artifact records into plain attachments, in place.
//
// `liveBlobIds` — the ids present in the project's blob store — decides what
// survives. A ref whose blob is gone was superseded back when a republish deleted
// what it displaced; those bytes are unrecoverable, so the ref is dropped rather
// than left to 404. A slot no item referenced is surfaced onto the last flow item:
// its blob is intact, and it was only invisible because the publishing flow had
// emitted nothing for the ref to land on.
export function migrateArtifactsToAttachments(
  task: LegacyTask,
  liveBlobIds: ReadonlySet<string>,
): { moved: number; dropped: number; surfaced: number } {
  const placed = new Set<string>()
  let moved = 0
  let dropped = 0
  let surfaced = 0

  const asAttachment = (a: LegacyArtifact): Attachment => ({
    id: a.id,
    name: a.name,
    mime: a.mime,
    size: a.size,
  })

  for (const it of (task.items ?? []) as LegacyItem[]) {
    if (it.kind !== 'message' || !it.artifacts) continue
    for (const ref of it.artifacts) {
      if (!liveBlobIds.has(ref.id)) {
        dropped++
        continue
      }
      ;(it.attachments ??= []).push(asAttachment(ref))
      placed.add(ref.id)
      moved++
    }
    delete it.artifacts
  }

  for (const slot of task.artifacts ?? []) {
    if (placed.has(slot.id) || !liveBlobIds.has(slot.id)) continue
    const host = lastFlowItem(task)
    if (!host) continue
    ;(host.attachments ??= []).push(asAttachment(slot))
    placed.add(slot.id)
    surfaced++
  }
  delete task.artifacts

  return { moved, dropped, surfaced }
}

// The read-side guard, so the migration does not rewrite a file it has done.
export function hasArtifactRecords(task: LegacyTask): boolean {
  if (task.artifacts !== undefined) return true
  return ((task.items ?? []) as LegacyItem[]).some(
    (it) => it.kind === 'message' && it.artifacts,
  )
}
