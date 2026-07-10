import { agentDisplayName, formatAgentModelName } from './agentDisplay'
import type { Task, TokenUsage } from './types'

// The timestamp of a task's most recent *completed* update: the newest of its
// finished messages and its lifecycle events. The in-flight assistant message
// (still streaming) is skipped, so per-chunk churn doesn't count until the
// message lands — that's what keeps the unseen-update dot from flickering on
// mid-stream. ISO timestamps compare lexicographically, so the string max is a
// chronological max; empty string for a task with nothing complete yet.
export function latestUpdateAt(task: Task): string {
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

// Whether a task has unviewed updates: it carries a seen marker (set on
// creation or backfilled) and its latest completed update is newer than it.
// Drives the unseen dot, the kebab's "Mark unread" item, and the "Unread"
// filter view. A task with no marker yet reads as caught up.
export function isUnread(task: Task): boolean {
  return task.seenAt != null && latestUpdateAt(task) > task.seenAt
}

export function taskAgentModelName(agent: Task['agent'], model?: string): string {
  return formatAgentModelName(agentDisplayName(agent), model)
}

// The token usage of the task's most recent turn that reported any — the last
// assistant message carrying a `usage`. A streaming turn reports its usage live
// (summed across inferences so far), so this tracks the in-flight turn as it
// grows rather than lagging a turn behind.
export function latestUsage(task: Task): TokenUsage | undefined {
  for (let i = task.messages.length - 1; i >= 0; i--) {
    const u = task.messages[i].usage
    if (u) return u
  }
  return undefined
}

// Token usage summed across every turn of the task. The token counts and dollar
// cost add up; the model is taken from the latest turn (the task's current
// model), matching what the per-turn view shows. Cost stays undefined until some
// turn reports one (a turn still streaming hasn't). Undefined when no turn has
// reported usage at all.
export function totalUsage(task: Task): TokenUsage | undefined {
  const total = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  let cost: number | undefined
  let any = false
  for (const m of task.messages) {
    const u = m.usage
    if (!u) continue
    any = true
    total.input += u.input
    total.output += u.output
    total.cacheRead += u.cacheRead
    total.cacheCreation += u.cacheCreation
    if (u.costUsd !== undefined) cost = (cost ?? 0) + u.costUsd
  }
  if (!any) return undefined
  return { ...total, model: latestUsage(task)?.model, costUsd: cost }
}
