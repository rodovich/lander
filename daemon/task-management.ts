import type { AgentTaskView } from './agent'

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
// resumed session that the `lander wedge`/`lander land` call it remembers making
// no longer holds. Without it the session's last act is that call and nothing
// contradicts it, so the agent answers the reviving message as if still wedged.
//
// Provider-neutral by construction, and shaped like buildManifestBlock — a small
// self-framing block appended to the user prompt — for two reasons. It does NOT
// belong in Claude's `<task-context>` block: that block is delta-compared against
// a baseline the server stores, so a line that appears for one turn and vanishes
// counts as a change twice and costs a spurious full resend on the turn after.
// And codex has no turn-context block at all (daemon/flows/codex.ts), so putting
// it there would fix claude only.
export function buildRevivedBlock(prior: 'wedged' | 'landed'): string {
  return [
    '<task-revived>',
    `You were ${prior} when this message arrived; the message changed your ` +
      'status to riding.',
    '</task-revived>',
  ].join('\n')
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
