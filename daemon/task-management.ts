import { createHash } from 'node:crypto'
import type { AgentTaskView } from './agent'
import type { RevivedMarker } from '../server/protocol'

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
// and {{forwardable}} with a per-agent access sentence. The two providers diverge
// on the latter, because their channels differ in scope:
//
// Claude's --append-system-prompt is request-scoped — regenerated every
// invocation, never accumulated in the conversation — so it substitutes a static
// pointer and delivers the live grants through the per-turn task-context block,
// keeping the appended prompt byte-stable for prompt-cache reuse.
//
// Codex has no request-scoped channel, only the user message, so its template is
// delivered once per thread (see deliveryDigest/shouldDeliver) and it interpolates
// the live grants directly. Freshness comes from the digest being
// content-addressed: a grant flip re-renders, re-digests, and re-delivers on the
// next turn. That is also why the codex sentence must not claim to describe
// "this turn" — a superseded copy stays in codex's append-only history.
export function fillTaskPrompt(
  taskPromptTemplate: string,
  forwardable: string,
  id: string,
): string {
  return taskPromptTemplate
    .replace('{{id}}', id)
    .replace('{{forwardable}}', forwardable)
}

export function taskManagementPrompt(
  task: AgentTaskView,
  taskPromptTemplate: string,
  id: string,
): string {
  return fillTaskPrompt(taskPromptTemplate, forwardableAccess(task), id)
}

export function promptWithTaskManagement(
  task: AgentTaskView,
  prompt: string,
  taskPromptTemplate: string,
  id: string,
): string {
  return `${taskManagementPrompt(task, taskPromptTemplate, id)}\n\n${prompt}`
}

// The prompt block a revived task's first turn carries: one sentence telling the
// resumed session what the arriving message changed out from under it. The
// session's own last act was `lander wedge`/`lander land`/`lander rest` and
// nothing else contradicts that memory, so left alone the agent answers as if
// still wedged — or re-arms nothing and lets a cleared timer go unreplaced.
//
// Two facts, either or both (see RevivedMarker): the notable status it was pulled
// out of, and a rest timer the message cleared. The timer clause names the time,
// because "your wakeup is gone" is only actionable if the agent knows which
// wakeup — and it points at `lander rest` because re-arming is the whole remedy.
// An await is never reported: it survives the revival, so nothing changed.
//
// Provider-neutral by construction, and shaped like buildManifestBlock — a small
// self-framing block appended to the user prompt — for two reasons. It does NOT
// belong in Claude's `<task-context>` block: that block is delta-compared against
// a baseline the server stores, so a line that appears for one turn and vanishes
// counts as a change twice and costs a spurious full resend on the turn after.
// And codex has no turn-context block at all (daemon/flows/codex.ts), so putting
// it there would fix claude only.
export function buildRevivedBlock(revived: RevivedMarker): string {
  // `resting` when no notable status was crossed — which is the case a cleared
  // timer arrives in almost every time.
  const prior = revived.from ?? 'resting'
  const sentence = revived.restUntil
    ? `You were ${prior} until ${revived.restUntil} when this message arrived; ` +
      'the message changed your status to riding and cleared that wakeup. ' +
      'Re-arm it with `lander rest` if you still want it.'
    : `You were ${prior} when this message arrived; the message changed your ` +
      'status to riding.'
  return ['<task-revived>', sentence, '</task-revived>'].join('\n')
}

export function forwardableAccess(task: AgentTaskView): string {
  if (task.agent === 'codex') {
    const permissions = task.allowEdits
      ? 'workspace-scoped edit permission profile'
      : 'workspace-scoped read-only permission profile'
    // "As of this message", not "this turn": the sentence is interpolated into a
    // template that codex now receives once per thread, so a copy of it sits in
    // history being read on later turns. A grant change re-renders and
    // re-delivers it (the digest is content-addressed), but the superseded copy
    // stays — append-only history — so the wording must not assert a fact about
    // whichever turn happens to be reading it.
    return (
      `As of this message, this task runs with the ${permissions}. ` +
      'Task allow rules are stored by Lander but do not affect Codex runs yet'
    )
  }

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
