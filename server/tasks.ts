// Task message/event types and the small pure helpers over them: the public
// (token-stripped) projection, the "latest completed update" timestamp behind
// the unseen dot, the lifecycle-event recorder, and the in-flight-message
// accessors. Typed structurally so they can be unit-tested without the full
// server Task type (index.ts passes its Task, which satisfies these shapes).

import path from 'node:path'
import type { Step, Usage } from './stream'

export type Message = {
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  // Present on assistant turns that were streamed: the live activity trace.
  steps?: Step[]
  // Present on assistant turns once the run's terminal result event lands: the
  // token counts the turn consumed. The UI shows the latest in the corner.
  usage?: Usage
  // True while claude is still producing this message; cleared when it lands.
  pending?: boolean
  // Client-facing only: set by publicTask on a follow-up still in the task's
  // `queued` work queue (claude hasn't read it yet) so the UI can dim it. Derived
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
    // session so the next turn mints a fresh claude session (see sealForRelaunch).
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

// Strip the secret `token` (and the server-internal run pointers) before sending
// a task over HTTP, so the UI — and any task scraping the API — can't read
// another task's token and impersonate it. A shallow copy: the messages/events
// arrays are shared with the source, not deep-cloned.
export function publicTask<T extends object>(
  task: T,
): Omit<T, 'token' | 'runId' | 'runCursor' | 'queued'> {
  const {
    token: _t,
    runId: _r,
    runCursor: _c,
    queued,
    ...rest
  } = task as T & {
    token?: unknown
    runId?: unknown
    runCursor?: unknown
    queued?: string[]
    messages?: Message[]
  }
  // Project the internal work queue onto the messages it refers to, then drop the
  // queue itself. The unread follow-ups are the trailing N user messages (the
  // queue holds one entry per unread follow-up, in order), so flag those. The
  // client renders the flag — dimming what claude hasn't read — without seeing
  // the server's queue or having to know that trailing-N rule. When nothing is
  // queued we return the messages array untouched (shared, not cloned).
  const slot = rest as { messages?: Message[] }
  const messages = slot.messages
  if (messages && queued?.length) {
    const flagged = new Set<number>()
    let remaining = queued.length
    for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
      if (messages[i].role === 'user') {
        flagged.add(i)
        remaining--
      }
    }
    slot.messages = messages.map((m, i) =>
      flagged.has(i) ? { ...m, queued: true } : m,
    )
  }
  return rest as Omit<T, 'token' | 'runId' | 'runCursor' | 'queued'>
}

// The timestamp of a task's most recent *completed* update: the newest of its
// finished messages (the in-flight, still-streaming one is skipped) and its
// lifecycle events. Mirrors the client's helper of the same name; used to seed
// `seenAt` for tasks that predate the field. ISO timestamps compare
// lexicographically, so the string max is a chronological max. Empty string
// when nothing has completed yet (e.g. only an in-flight message exists).
export function latestUpdateAt(task: {
  messages: Message[]
  events?: TaskEvent[]
}): string {
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

// Record a crossing into or out of a "notable" status — "wedged" (the task
// needs the user) or the terminal "landed" — as a timeline event, so the UI can
// show it inline among the messages. Entering a notable status records it
// ("wedged"/"landed"); leaving one for an un-notable status (riding/resting)
// records the inverse ("unwedged"/"unlanded"). A no-op for moves between two
// quiet statuses (e.g. riding↔resting) or that don't change status. Moving
// straight between two notable statuses (wedged↔landed) records the arrival
// only. Call before assigning the new status, while task.status holds the old.
export function recordStatusTransition(
  task: { status: string; title: string; events?: TaskEvent[] },
  next: string,
  at: string,
): void {
  const prev = task.status
  if (prev === next) return
  const events = (task.events ??= [])
  if (next === 'wedged' || next === 'landed')
    events.push({ kind: next, title: task.title, createdAt: at })
  else if (prev === 'wedged' || prev === 'landed')
    events.push({
      kind: prev === 'wedged' ? 'unwedged' : 'unlanded',
      title: task.title,
      createdAt: at,
    })
}

// Seal a task's assistant session so its next turn mints a fresh claude session,
// and record the 'relaunched' divider event. This is the heart of `lander
// relaunch`: the daemon mints a new session whenever it's handed a turn with no
// `sessionId` (it `--resume`s the same one otherwise), so deleting the field is
// all it takes — the new session is minted lazily on the next turn that drains a
// queued message, never pre-allocated. The old session's still-streaming turn is
// a `--resume`, which emits no session announcement, so nothing races this clear
// (see reduceRunWs's set-once `if (!t.sessionId)`). Touches only session + event
// state; the caller owns the message/queue/status for the next turn.
export function sealForRelaunch(
  task: { sessionId?: string; title: string; events?: TaskEvent[] },
  at: string,
): void {
  delete task.sessionId
  ;(task.events ??= []).push({ kind: 'relaunched', title: task.title, createdAt: at })
}

// The immediate `lander relaunch <message>` mutation: seal the session, then
// append the relaunch message and queue it for the (now fresh) session, going
// riding. Called mid-turn of the old session in the normal path — the in-flight
// driveTask loop drains the queued message after the current turn's `done`, and
// because the session is sealed that turn hands the daemon no `sessionId`, so a
// new session is minted. Revives a wedged/landed task too (records the un-wedge a
// hair ahead so the timeline orders right), and supersedes any pending retry.
export function applyRelaunch(
  task: {
    sessionId?: string
    status: string
    title: string
    updatedAt?: string
    events?: TaskEvent[]
    messages: Message[]
    queued?: string[]
    retry?: unknown
  },
  message: string,
  at: string,
): void {
  recordStatusTransition(task, 'riding', new Date(Date.parse(at) - 1).toISOString())
  sealForRelaunch(task, at)
  task.messages.push({ role: 'user', text: message, createdAt: at })
  ;(task.queued ??= []).push(message)
  task.status = 'riding'
  task.updatedAt = at
  delete task.retry
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
    events?: TaskEvent[]
    messages: Message[]
    queued?: string[]
  },
  due: { text: string; relaunch?: boolean }[],
  at: string,
): void {
  const relaunch = due.filter((m) => m.relaunch)
  const rest = due.filter((m) => !m.relaunch)
  // Seal once even if several relaunch entries are due in the same sweep.
  if (relaunch.length) sealForRelaunch(task, at)
  for (const m of [...relaunch, ...rest]) {
    task.messages.push({ role: 'user', text: m.text, createdAt: at })
    ;(task.queued ??= []).push(m.text)
  }
}

// Arm a scheduled relaunch: stash a relaunch-flagged scheduled message whose own
// `deliverAt`/`waitFor` trigger seals the session on delivery, and record a
// pending 'relaunched' event (carrying the launch time, when known) so the UI
// shows the coming relaunch. Crucially does NOT clear `sessionId` now — the old
// session stays live until the trigger fires, so pre-trigger interim messages
// still resume it, consistent with every other scheduled wakeup. We deliberately
// don't set task-level `scheduledFor` (that would block delivery and could
// double-fire launchTask); the message's own trigger drives it.
export function armScheduledRelaunch(
  task: {
    title: string
    events?: TaskEvent[]
    scheduledMessages?: { text: string; deliverAt?: string; waitFor?: string[]; relaunch?: boolean }[]
  },
  entry: { text: string; deliverAt?: string; waitFor?: string[] },
  at: string,
): void {
  ;(task.scheduledMessages ??= []).push({ ...entry, relaunch: true })
  const event: TaskEvent = { kind: 'relaunched', title: task.title, createdAt: at }
  if (entry.deliverAt) event.scheduledFor = entry.deliverAt
  ;(task.events ??= []).push(event)
}

// The user messages that made up a task's most recent turn: the consecutive run
// of user messages immediately before the trailing assistant message(s). After a
// turn ends (or errors) the assistant's reply is the last message, with that
// turn's prompt(s) just before it — a batched turn carries several. Used by the
// retry path to re-send a turn whose prompt never reached the session.
export function lastTurnPrompts(messages: Message[]): string[] {
  let i = messages.length - 1
  while (i >= 0 && messages[i].role === 'assistant') i--
  const prompts: string[] = []
  while (i >= 0 && messages[i].role === 'user') {
    prompts.unshift(messages[i].text)
    i--
  }
  return prompts
}

// Locate the in-flight assistant message (the one a run is streaming into).
export function pendingMessage(task: {
  messages: Message[]
}): Message | undefined {
  for (let i = task.messages.length - 1; i >= 0; i--) {
    const m = task.messages[i]
    if (m.role === 'assistant' && m.pending) return m
  }
  return undefined
}

// Get the in-flight assistant message, creating it on first use. We hold off on
// adding it until claude actually starts responding so its `createdAt` reflects
// when the agent began — not when the turn was queued — and so the UI can show a
// spinner under the user's message during the wait. Until then a riding task has
// no trailing assistant message.
export function ensurePending(task: { messages: Message[] }): Message {
  let msg = pendingMessage(task)
  if (!msg) {
    msg = {
      role: 'assistant',
      text: '',
      createdAt: new Date().toISOString(),
      steps: [],
      pending: true,
    }
    task.messages.push(msg)
  }
  return msg
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
