import { describe, expect, it } from 'vitest'
import {
  latestUpdateAt,
  latestUsageRide,
  taskUsageSummary,
  totalRideMs,
  usageBreakdown,
} from './taskMeta'
import type { UsageRow } from './taskMeta'
import type { Ride, Task, TokenUsage } from './types'

describe('latestUpdateAt', () => {
  it('does not count the acting task’s own task-action row as unread activity', () => {
    const task = {
      id: 'actor',
      title: 'Actor',
      status: 'riding',
      createdAt: '2026-08-21T19:00:00.000Z',
      allowEdits: false,
      items: [
        {
          id: 'a1',
          at: '2026-08-21T20:00:00.000Z',
          kind: 'task-action',
          action: 'launch',
          target: { id: 'child', projectSlug: 'proj' },
        },
      ],
      rides: [],
    } as Task
    expect(latestUpdateAt(task)).toBe('')
  })
})

const usage = (over: Partial<TokenUsage> = {}): TokenUsage => ({
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheCreation: 0,
  ...over,
})

const withRides = (rides: Ride[]): Task =>
  ({
    id: 't',
    title: 'T',
    status: 'resting',
    createdAt: '2026-09-09T00:00:00.000Z',
    allowEdits: false,
    items: [],
    rides,
  }) as Task

describe('totalRideMs', () => {
  it('sums the rides it can time and skips the ones it cannot', () => {
    const total = totalRideMs(
      withRides([
        { id: 'r1', startedAt: '…', endedAt: '…', durationMs: 10_000 },
        // Untimed: contributes nothing rather than voiding the sum.
        { id: 'r2', startedAt: '…', endedAt: '…' },
        { id: 'r3', startedAt: '…', endedAt: '…', durationMs: 5_000 },
      ]),
    )
    expect(total).toBe(15_000)
  })

  it('holds still through an in-flight turn rather than tracking the clock', () => {
    // The open ride started an hour ago and has been measured by nobody. The
    // total is the two minutes that landed, and it moves next when a done does.
    const rides: Ride[] = [
      { id: 'r1', startedAt: '…', endedAt: '…', durationMs: 120_000 },
      { id: 'r2', startedAt: '2026-09-09T11:00:00.000Z' },
    ]
    expect(totalRideMs(withRides(rides))).toBe(120_000)
  })

  it('is undefined when no ride has been measured at all', () => {
    expect(
      totalRideMs(withRides([{ id: 'r1', startedAt: '…', endedAt: '…' }])),
    ).toBeUndefined()
  })
})

describe('latestUsageRide', () => {
  it('returns the ride the counts came off, so the footer times that same turn', () => {
    const ride = latestUsageRide(
      withRides([
        { id: 'r1', startedAt: '…', endedAt: '…', usage: usage(), durationMs: 1_000 },
        // Newer, but reported no usage — the footer's counts skip it, so its
        // time must be skipped with them.
        { id: 'r2', startedAt: '…', endedAt: '…', durationMs: 99_000 },
      ]),
    )
    expect(ride?.id).toBe('r1')
  })

  it('returns the in-flight ride, which reports counts but no time yet', () => {
    // What the footer reads mid-turn: the counts climb off this ride while its
    // `durationMs` — measured only at the done — is still absent, so the time
    // is omitted until the turn lands rather than guessed at from its start.
    const ride = latestUsageRide(
      withRides([
        { id: 'r1', startedAt: '…', endedAt: '…', usage: usage(), durationMs: 1_000 },
        { id: 'r2', startedAt: '…', usage: usage() },
      ]),
    )
    expect(ride?.id).toBe('r2')
    expect(ride?.durationMs).toBeUndefined()
  })
})

describe('taskUsageSummary', () => {
  it('sums the task: who did the work, how long it took, what it cost', () => {
    const items = taskUsageSummary(
      withRides([
        {
          id: 'r1',
          startedAt: '…',
          endedAt: '…',
          durationMs: 60_000,
          usage: usage({ model: 'claude-opus-5', costUsd: 0.5 }),
        },
        {
          id: 'r2',
          startedAt: '…',
          endedAt: '…',
          durationMs: 23_000,
          usage: usage({ model: 'claude-opus-5', costUsd: 0.25 }),
        },
      ]),
    )
    expect(items?.map((i) => i.id)).toEqual(['model', 'time', 'cost'])
    expect(items?.map((i) => 'value' in i && i.value)).toEqual([
      'Assistant (claude-opus-5)',
      '1m 23s',
      '$0.75',
    ])
  })

  it('drops the time and the cost from the line when it has no figure', () => {
    // A riding turn: the counts are climbing, but nothing has measured the ride
    // or landed its cost. The summary says the model and stops there.
    const items = taskUsageSummary(withRides([{ id: 'r1', startedAt: '…', usage: usage() }]))
    expect(items?.map((i) => i.id)).toEqual(['model'])
  })

  it('drops the cost for a flow that reports none, like any other absence', () => {
    const free = {
      ...withRides([
        { id: 'r1', startedAt: '…', endedAt: '…', durationMs: 1_000, usage: usage() },
      ]),
      reportsCost: false,
    } as Task
    expect(taskUsageSummary(free)?.map((i) => i.id)).toEqual(['model', 'time'])
  })

  it('names the flow before any turn has reported anything', () => {
    // What a codex task shows for its whole first turn, since its usage lands
    // only when the turn does: who is working, if not yet on what or for how
    // long. The flow is known from launch, so it never waits on a measurement.
    const fresh = { ...withRides([]), flow: 'codex' } as Task
    expect(taskUsageSummary(fresh)).toEqual([
      { id: 'model', label: 'model', type: 'text', value: 'Codex' },
    ])
  })
})

describe('usageBreakdown', () => {
  const cell = (groups: UsageRow[][], id: string) =>
    groups.flat().find((r) => r.id === id)

  it('groups the counts apart from what they cost in time and money', () => {
    const { groups } = usageBreakdown(
      withRides([{ id: 'r1', startedAt: '…', endedAt: '…', usage: usage() }]),
    )
    expect(groups.map((g) => g.map((r) => r.id))).toEqual([
      ['input', 'cacheWrite', 'cacheRead', 'output'],
      ['time', 'cost'],
    ])
  })

  it('reads the turn off the ride its counts came from, beside the task’s sum', () => {
    const { groups } = usageBreakdown(
      withRides([
        {
          id: 'r1',
          startedAt: '…',
          endedAt: '…',
          durationMs: 60_000,
          usage: usage({ input: 100, cacheCreation: 20, cacheRead: 3_000, output: 40 }),
        },
        {
          id: 'r2',
          startedAt: '…',
          endedAt: '…',
          durationMs: 23_000,
          usage: usage({ input: 5, cacheCreation: 2, cacheRead: 9_000, output: 7 }),
        },
      ]),
    )
    expect(cell(groups, 'time')).toMatchObject({ turn: '23s', total: '1m 23s' })
    expect(cell(groups, 'input')).toMatchObject({ turn: '5', total: '105' })
    expect(cell(groups, 'cacheWrite')).toMatchObject({ turn: '2', total: '22' })
    expect(cell(groups, 'cacheRead')).toMatchObject({
      turn: (9_000).toLocaleString(),
      total: (12_000).toLocaleString(),
    })
    expect(cell(groups, 'output')).toMatchObject({ turn: '7', total: '47' })
  })

  it('marks the in-flight turn’s time absent while its counts climb', () => {
    // The open ride is measured only at the done, so its column shows no time —
    // an em dash, not the zero a missing measurement would otherwise read as.
    const { groups } = usageBreakdown(
      withRides([
        { id: 'r1', startedAt: '…', endedAt: '…', durationMs: 1_000, usage: usage() },
        { id: 'r2', startedAt: '…', usage: usage() },
      ]),
    )
    expect(cell(groups, 'time')).toMatchObject({ turn: '—', total: '1s' })
  })

  it('reads an absent cost as unmeasured, whatever made it absent', () => {
    // Nothing has landed a cost yet — the cells take the same em dash the
    // in-flight turn's time takes.
    const riding = withRides([{ id: 'r1', startedAt: '…', usage: usage() }])
    expect(cell(usageBreakdown(riding).groups, 'cost')).toMatchObject({
      turn: '—',
      total: '—',
    })
    // And a flow that reports no account cost at all (codex, open-pr) reads the
    // same: the table states what it knows, and here it knows no number.
    const free = { ...riding, reportsCost: false } as Task
    expect(cell(usageBreakdown(free).groups, 'cost')).toMatchObject({
      turn: '—',
      total: '—',
    })
  })

  it('rounds the cost to the penny, as the summary does', () => {
    const { groups } = usageBreakdown(
      withRides([
        { id: 'r1', startedAt: '…', endedAt: '…', usage: usage({ costUsd: 0.4267 }) },
      ]),
    )
    expect(cell(groups, 'cost')).toMatchObject({ turn: '$0.43' })
  })

  it('carries the turn’s cache miss as a note, since misses do not sum', () => {
    const { cacheMiss } = usageBreakdown(
      withRides([
        {
          id: 'r1',
          startedAt: '…',
          endedAt: '…',
          usage: usage({ cacheMiss: { reason: 'tools_changed', missedTokens: 24_000 } }),
        },
      ]),
    )
    expect(cacheMiss).toBe(
      `cache miss: tools changed (${(24_000).toLocaleString()} tokens missed)`,
    )
  })

  it('has no note when the turn’s cache was clean', () => {
    expect(
      usageBreakdown(
        withRides([{ id: 'r1', startedAt: '…', endedAt: '…', usage: usage() }]),
      ).cacheMiss,
    ).toBeUndefined()
  })
})
