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
