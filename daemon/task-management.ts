import type { AgentTaskView } from './agent'
import type { RevivedMarker } from '../server/protocol'

// Fill the task prompt template's slots: {{id}} with the task's own id (constant
// for the task's life, so it's safe in Claude's byte-stable --append-system-prompt)
// and {{forwardable}} with a per-agent access sentence. The two adapters diverge on
// the latter: Codex interpolates the live grants (its whole template rides the user
// message each turn, so it's always fresh); Claude substitutes a static pointer and
// delivers the live grants via the per-turn task-context block instead, keeping its
// --append-system-prompt byte-stable across turns for prompt-cache reuse.
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
    return (
      `This Codex turn runs with the ${permissions}. ` +
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
