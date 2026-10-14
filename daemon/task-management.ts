import { createHash } from 'node:crypto'
import type { RevivedMarker, ScheduledRide } from '../server/protocol'

// Deliver-once, for a provider whose only channel for lander's own prose is the
// user message — i.e. codex, where a message put in front of one turn stays in
// that turn's message forever and is replayed on every later one.
//
// The pair is deliberately PURE: it takes the state values rather than a Ctx, so
// this module keeps no dependency on daemon/flows (which imports
// buildRevivedBlock from here — the reverse edge would be a cycle) and stays
// testable without a harness. The caller owns the two state touches.
//
// The contract is a two-phase one, and the phases must stay split:
//
//   decide (before the spawn)  shouldDeliver(sessionId, ctx.state.get([key]), digest)
//   commit (after the turn)    ctx.state.set([key], digest) — only if it delivered
//                              AND the turn produced output
//
// "Produced output" is the whole safety argument: the model emitting a step or a
// reply proves it consumed the turn, which proves the thread exists, is durable,
// and holds that turn's user message. Committing earlier than that records a
// delivery that may not have happened, which is permanent; committing later, or
// never, costs one duplicate copy. Every failure direction must stay on the
// duplicate side.
export function deliveryDigest(text: string): string {
  // Stable across processes and versions — a per-process salt would re-deliver
  // every turn, the benign direction, but would look like success in a
  // single-session test. Prefixed so a future format change compares unequal
  // loudly rather than by accident.
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

// `!sessionId` is not belt-and-braces; it is the invariant. `sealForRelaunch`
// deletes the whole flowState blob mid-turn, and the dying turn's flush can then
// replay a buffered patch that restores the digest alone (server/tasks.ts,
// daemon/run.ts) — leaving a task with a delivery record and no thread. Without
// this disjunct the fresh thread inherits "delivered" and is sealed for life.
// Claude carries the same guard for its context block, for the same reason.
export function shouldDeliver(
  sessionId: string | undefined,
  delivered: unknown,
  digest: string,
): boolean {
  return !sessionId || delivered !== digest
}

// Fill the task prompt template's slots: {{id}} with the task's own id (constant
// for the task's life, so it's safe in Claude's byte-stable --append-system-prompt)
// and {{forwardable}} with the flow's account of what edit access covers under
// its provider and what this task holds. The flow supplies that text because
// both halves are provider facts: the reach of an edit grant follows the
// provider's permission mechanism, and where the live grants can be stated
// follows its prose channel.
export function fillTaskPrompt(
  taskPromptTemplate: string,
  forwardable: string,
  id: string,
): string {
  // Replacer functions, so a `$&` or `$'` in the inserted prose stays literal.
  return taskPromptTemplate
    .replace('{{id}}', () => id)
    .replace('{{forwardable}}', () => forwardable)
}

// The prompt block a revived task's first turn carries: one sentence telling the
// resumed session what the arriving message changed out from under it. The
// session's own last act was `lander wedge`/`lander land`/`lander ride` and
// nothing else contradicts that memory, so left alone the agent answers as if
// still wedged — or re-arms nothing and lets a cleared timer go unreplaced.
//
// Two facts, either or both (see RevivedMarker): the notable status it was pulled
// out of, and the scheduled time the message cleared. The ride clause names the
// time, because "your ride is cleared" is only actionable if the agent knows
// which ride — and it points at `lander ride` because scheduling it again is the
// remedy. An await is not mentioned here: it survives the revival, and the turn's
// scheduled-ride reminder (buildScheduledRideBlock) reports it, warning that
// scheduling a ride replaces it.
//
// Provider-neutral by construction, and shaped like buildManifestBlock — a small
// self-framing block appended to the user prompt — for two reasons. It does NOT
// belong in Claude's `<task-context>` block: that block is delta-compared against
// a baseline the server stores, so a line that appears for one turn and vanishes
// counts as a change twice and costs a spurious full resend on the turn after.
// And codex has no turn-context block at all (daemon/flows/codex.ts), so putting
// it there would fix claude only.
export function buildRevivedBlock(revived: RevivedMarker): string {
  // `waiting` when no notable status was crossed — which is the case a cleared
  // ride arrives in almost every time.
  const prior = revived.from ?? 'waiting'
  const sentence = revived.waitingUntil
    ? `You were ${prior} until ${revived.waitingUntil} when this message arrived; ` +
      'the message changed your status to riding and cleared the ride you had ' +
      'scheduled for then. Schedule it again with `lander ride` if you still ' +
      'want it.'
    : `You were ${prior} when this message arrived; the message changed your ` +
      'status to riding.'
  return ['<task-revived>', sentence, '</task-revived>'].join('\n')
}

// The prompt block a turn carries while a ride is still scheduled behind it: the
// turn was woken by something else — a notification, another task's message, or
// the human's message with an await left standing — and the ride it scheduled
// earlier is not in its own context unless it remembers it. Without this the
// agent re-schedules a ride that is still there, or forgets one it no longer
// needs. Shaped like buildRevivedBlock, and for the same two reasons.
export function buildScheduledRideBlock(ride: ScheduledRide): string {
  const awaiting = ride.awaiting ?? []
  const landing = awaiting.length
    ? `when ${awaiting.join(', ')} ${awaiting.length > 1 ? 'have all landed' : 'lands'}`
    : ''
  const when =
    ride.at && landing
      ? `for ${ride.at} or ${landing}, whichever comes first`
      : `for ${ride.at ?? landing}`
  const sentence =
    `You have a ride scheduled ${when}. It stays scheduled unless you clear ` +
    'it with `lander ride --clear`; scheduling another with `lander ride` ' +
    'replaces it.'
  return ['<ride-scheduled>', sentence, '</ride-scheduled>'].join('\n')
}

// What an agent working in a lander-managed checkout must know about it: where
// it is, that it starts with no branch, and that it does not outlive the task.
// Constant for the task's life, so it can ride Claude's byte-stable appended
// system prompt.
export function checkoutNote(checkout: string, root: string): string {
  return (
    `This task works in a git worktree lander created for it at \`${checkout}\`, ` +
    `starting detached at whatever the project's main checkout (\`${root}\`) had ` +
    'checked out. Commit on a branch you create: lander removes this worktree ' +
    'when the task is landed or archived, and leaves branches alone.'
  )
}

export function forwardableAccess(task: { allowEdits: boolean }): string {
  if (task.allowEdits) {
    return (
      'You currently have permission for editing files, and can forward that ' +
      'to a spawned task'
    )
  }
  return (
    'You currently have no edit permission, so a spawned task cannot be ' +
    'granted it either'
  )
}
