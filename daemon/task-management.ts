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
    const sandbox = task.allowEdits
      ? 'workspace-write sandbox for file edits'
      : 'read-only sandbox'
    return (
      `This Codex turn runs with the ${sandbox}. ` +
      'Task allow rules and commit-only grants are stored by Lander but do not ' +
      'affect Codex runs yet'
    )
  }

  const held = [
    task.allowEdits && 'editing files',
    task.allowCommits && 'git commits',
  ].filter(Boolean) as string[]
  if (held.length) {
    return (
      `You currently have permission for ${held.join(' and ')}, and can ` +
      'forward that to a spawned task'
    )
  }
  return (
    'You currently have no edit or commit permissions, so a spawned task ' +
    'cannot be granted them either'
  )
}
