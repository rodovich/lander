import { agentDisplayName, formatAgentModelName } from './agentDisplay'
import { formatCost, formatDuration } from './format'
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
    } else if (it.kind === 'message' && it.role === 'hook') {
      // A hook's nudge is new activity on the task, so it lights the unseen dot
      // like any other arriving message.
      if (it.at > latest) latest = it.at
    } else if (it.kind === 'hook') {
      // A hook run's report — a finding, or an account of why one could not run.
      // Counted here so a bound refusal is visible rather than silent; the
      // stored record deliberately does not bump `updatedAt` for it, so this is
      // the only thing that surfaces it.
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

// The task's most recent ride that reported any usage. A streaming turn reports
// its usage live (summed across inferences so far, moved onto the open ride), so
// this tracks the in-flight turn as it grows rather than lagging a turn behind.
// The ride rather than the usage, so the footer's other per-turn readouts come
// off the same turn the counts do.
export function latestUsageRide(task: Task): Ride | undefined {
  const rides = task.rides ?? []
  for (let i = rides.length - 1; i >= 0; i--) if (rides[i].usage) return rides[i]
  return undefined
}

export function latestUsage(task: Task): TokenUsage | undefined {
  return latestUsageRide(task)?.usage
}

// Working time summed across the task's rides. A ride that reported none
// contributes nothing rather than voiding the sum — the same best effort
// `totalUsage` makes of a turn that reported no cost — so the total reads as
// "at least this long", and is undefined only when no ride has been measured.
//
// Nothing here consults the clock. A ride is measured by the daemon and the
// measurement arrives with the turn's done, so the readout advances a turn at a
// time, in step with the counts beside it, and an in-flight turn contributes
// nothing until it lands. Estimating the open ride from `startedAt` would put a
// number on screen that no measurement backs and that climbs on the poll
// interval rather than on anything the run did.
export function totalRideMs(task: Task): number | undefined {
  let total = 0
  let any = false
  for (const r of task.rides ?? []) {
    if (r.durationMs === undefined) continue
    total += r.durationMs
    any = true
  }
  return any ? total : undefined
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

// The composer footer's summary as generic telemetry items: who did the work
// (provider & model), how long the task has spent working, and what it has cost.
// Task-scope throughout — the breakdown behind it is where a single turn is
// broken out — so the line read at a glance is the enduring number rather than
// the transient one. Client-derived (this surface stays simple — the daemon
// doesn't publish it), fed to the same generic item renderer the flow-status
// panel uses.
//
// The line always names the flow, which a task carries from the moment it is
// launched — so a task that has never ridden, or one whose provider reports its
// usage only when the turn lands (codex), still says who is doing the work while
// it does it. The model qualifies that name once some turn has reported one.
export function taskUsageSummary(task: Task): TelemetryItem[] {
  const u = totalUsage(task)
  const elapsed = totalRideMs(task)
  return [
    {
      id: 'model',
      label: 'model',
      type: 'text',
      // The flow name is the model-name display lookup only, never a behavior
      // branch.
      value: taskAgentModelName(task.flow ?? task.agent, u?.model),
    },
    // Time leads cost: it is the shape of the work, where cost is its price.
    // Either is dropped from the line when it has no figure — whether none has
    // landed yet or the flow reports none at all — rather than held open by a
    // placeholder. A summary is read at a glance, and a glance at "$…" learns
    // nothing the missing item wouldn't have said by its absence.
    ...(elapsed !== undefined
      ? [
          {
            id: 'time',
            label: 'time',
            type: 'text',
            value: formatDuration(elapsed),
          } as const,
        ]
      : []),
    ...(u?.costUsd !== undefined
      ? [
          {
            id: 'cost',
            label: 'cost',
            type: 'text',
            value: formatCost(u.costUsd),
          } as const,
        ]
      : []),
  ]
}

// One row of the usage breakdown: a label and its value in each scope. Every
// cell is preformatted, so the table that renders these knows nothing about
// tokens, dollars, or which scope a number came from.
export type UsageRow = { id: string; label: string; turn: string; total: string }

// A scope that reported no number at all: an em dash rather than a zero, so
// "not measured" can't read as "took no time".
const NO_VALUE = '—'

const tokens = (n: number | undefined): string =>
  n === undefined ? NO_VALUE : n.toLocaleString()

// A cost cell. The two ways a scope can have no figure — none has landed yet,
// and this flow reports none at all — read the same here: the table states what
// is known, and neither case knows a number.
const money = (n: number | undefined): string =>
  n === undefined ? NO_VALUE : formatCost(n)

// The breakdown behind the footer summary: the same quantities the old
// turn/total toggle flipped between, laid out for both scopes at once — the
// latest turn that reported usage (the one the counts climb through while it
// rides) beside the whole task.
//
// The turn's working time is read off the very ride its counts came from: a
// readout that timed one turn and counted another would be describing nothing.
// It is absent while that ride is still in flight, since a ride's duration is
// only measured at the done — the counts climb through a turn, the time appears
// when it lands.
export function usageBreakdown(task: Task): {
  // Grouped as the table renders them — the counts, then what they cost in time
  // and money — so the two are told apart by a gap rather than a rule.
  groups: UsageRow[][]
  // The turn's cache-miss diagnostic, when the API reported one. A note rather
  // than a row: it belongs to the turn column alone, since misses don't sum.
  cacheMiss?: string
} {
  const turnRide = latestUsageRide(task)
  const turn = turnRide?.usage
  const total = totalUsage(task)
  const row = (
    id: string,
    label: string,
    of: (u: TokenUsage) => number,
  ): UsageRow => ({
    id,
    label,
    turn: tokens(turn && of(turn)),
    total: tokens(total && of(total)),
  })
  const time = (ms: number | undefined) =>
    ms === undefined ? NO_VALUE : formatDuration(ms)
  const miss = turn?.cacheMiss
  return {
    groups: [
      [
        // The two halves of the fresh input a turn processes — what was sent
        // uncached, and the part of it written to the cache for the next turn —
        // then the discounted re-read, then what came back.
        row('input', 'input', (u) => u.input),
        row('cacheWrite', 'cache write', (u) => u.cacheCreation),
        row('cacheRead', 'cache read', (u) => u.cacheRead),
        row('output', 'output', (u) => u.output),
      ],
      [
        {
          id: 'time',
          label: 'time',
          turn: time(turnRide?.durationMs),
          total: time(totalRideMs(task)),
        },
        {
          id: 'cost',
          label: 'cost',
          // The table holds its shape, so an absent cost takes the same em dash
          // an unmeasured time does rather than dropping the row.
          turn: money(turn?.costUsd),
          total: money(total?.costUsd),
        },
      ],
    ],
    cacheMiss: miss
      ? `cache miss: ${miss.reason.replaceAll('_', ' ')} ` +
        `(${miss.missedTokens.toLocaleString()} tokens missed)`
      : undefined,
  }
}
