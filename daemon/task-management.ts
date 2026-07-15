import type { AgentTaskView } from './agent'

// Fill the task prompt template's {{forwardable}} slot with the given sentence.
// The two adapters diverge on what goes there: Codex interpolates the live
// grants (its whole template rides the user message each turn, so it's always
// fresh); Claude substitutes a static pointer and delivers the live grants via
// the per-turn task-context block instead, keeping its --append-system-prompt
// byte-stable across turns for prompt-cache reuse.
export function fillTaskPrompt(
  taskPromptTemplate: string,
  forwardable: string,
): string {
  return taskPromptTemplate.replace('{{forwardable}}', forwardable)
}

export function taskManagementPrompt(
  task: AgentTaskView,
  taskPromptTemplate: string,
): string {
  return fillTaskPrompt(taskPromptTemplate, forwardableAccess(task))
}

export function promptWithTaskManagement(
  task: AgentTaskView,
  prompt: string,
  taskPromptTemplate: string,
): string {
  return `${taskManagementPrompt(task, taskPromptTemplate)}\n\n${prompt}`
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
