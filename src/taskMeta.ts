import { agentDisplayName, formatAgentModelName } from './agentDisplay'
import { formatCost } from './format'
import type { Ride, Task, TelemetryItem, TokenUsage } from './types'

// The task's currently-open ride (the last one without an `endedAt`), if any —
// what a riding task is streaming into. Mirrors the server's openRide.
function openRide(task: { rides?: Ride[] }): Ride | undefined {
  const rides = task.rides
  if (!rides) return undefined
  for (let i = rides.length - 1; i >= 0; i--)
    if (!rides[i].endedAt) return rides[i]
  return undefined
}

// The timestamp of a task's most recent *completed* update, drives the unseen
// dot. Byte-for-byte the value the pre-item-log helper produced (so a `seenAt`
// stored before this migration stays valid and read tasks don't re-surface as
// unread): the newest of the user messages, the *settled* rides' start times
// (the old per-turn assistant message carried the turn's start as its
// `createdAt`, and only that — never its streamed steps), and the lifecycle
// events. The in-flight ride (its items and its own start) is skipped, so
// per-chunk churn doesn't count until the turn lands. ISO timestamps compare
// lexicographically, so the string max is a chronological max; empty string for
// a task with nothing complete yet.
export function latestUpdateAt(task: Task): string {
  const open = openRide(task)
  let latest = ''
  for (const it of task.items ?? []) {
    // User messages and lifecycle events stamp their own moment; a settled
    // ride's flow/tool items don't (the turn's timestamp is its ride start).
    if (it.kind === 'message' && it.role === 'user') {
      if (it.at > latest) latest = it.at
    } else if (it.kind === 'event') {
      if (it.at > latest) latest = it.at
    }
  }
  for (const r of task.rides ?? []) {
    // Skip the open ride (the in-flight turn); a settled turn contributes its
    // start time, matching the old assistant message's `createdAt`.
    if (open && r.id === open.id) continue
    if (r.startedAt > latest) latest = r.startedAt
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

// Takes a flow NAME, not a closed agent union: agentDisplayName falls back to
// the trimmed raw string, so an `open-pr` task renders "open-pr".
export function taskAgentModelName(agent: string | undefined, model?: string): string {
  return formatAgentModelName(agentDisplayName(agent), model)
}

// The token usage of the task's most recent ride that reported any — the last
// ride carrying a `usage`. A streaming turn reports its usage live (summed across
// inferences so far, moved onto the open ride), so this tracks the in-flight turn
// as it grows rather than lagging a turn behind.
export function latestUsage(task: Task): TokenUsage | undefined {
  const rides = task.rides ?? []
  for (let i = rides.length - 1; i >= 0; i--) {
    const u = rides[i].usage
    if (u) return u
  }
  return undefined
}

// Token usage summed across every ride of the task. The token counts and dollar
// cost add up; the model is taken from the latest ride (the task's current
// model), matching what the per-turn view shows. Cost stays undefined until some
// ride reports one (a turn still streaming hasn't). Undefined when no ride has
// reported usage at all.
export function totalUsage(task: Task): TokenUsage | undefined {
  const total = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
  let cost: number | undefined
  let any = false
  for (const r of task.rides ?? []) {
    const u = r.usage
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

// The composer footer's token readout as generic telemetry items: the driving
// model, the turn's uncached input / cache read / output counts, and its cost.
// Client-derived (this surface stays simple — the daemon doesn't publish it), fed
// to the same generic item renderer the flow-status panel uses.
export function taskUsageTelemetry(
  u: TokenUsage,
  // The flow name, for the model-name display lookup only — never a behavior
  // branch.
  agent: string | undefined,
  reportsCost: boolean,
): TelemetryItem[] {
  // Uncached = fresh input processed this turn (regular input + the part written
  // to cache); cache read is the discounted re-read, reported separately.
  const uncached = u.input + u.cacheCreation
  // Claude cost arrives with the turn's result event; a provider that reports no
  // account cost (codex) shows 'n/a', and a still-streaming turn hasn't landed one
  // yet. `agent` stays only the model-name display lookup below, never a behavior
  // branch — the cost decision reads the server-derived capability.
  const cost =
    u.costUsd !== undefined ? formatCost(u.costUsd) : reportsCost ? '$…' : 'n/a'
  return [
    {
      id: 'model',
      label: 'model',
      type: 'text',
      value: taskAgentModelName(agent, u.model),
    },
    { id: 'in', label: 'in', type: 'count', value: uncached },
    { id: 'cache', label: 'cache', type: 'count', value: u.cacheRead },
    { id: 'out', label: 'out', type: 'count', value: u.output },
    { id: 'cost', label: 'cost', type: 'text', value: cost },
  ]
}
