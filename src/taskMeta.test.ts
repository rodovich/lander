import { describe, expect, it } from 'vitest'
import {
  latestUpdateAt,
  latestUsageRide,
  taskUsageTelemetry,
  totalRideMs,
} from './taskMeta'
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

describe('taskUsageTelemetry time item', () => {
  it('places time ahead of the counts', () => {
    const items = taskUsageTelemetry(usage(), 'claude', true, 83_000)
    expect(items.map((i) => i.id)).toEqual(['model', 'time', 'in', 'cache', 'out', 'cost'])
    expect(items[1]).toMatchObject({ type: 'text', value: '1m 23s' })
  })

  it('omits the item entirely when there is no measurement', () => {
    // Not a '…' placeholder like an unlanded cost: that would promise a number
    // is coming, and for an unmeasured ride none ever is.
    const items = taskUsageTelemetry(usage(), 'claude', true)
    expect(items.map((i) => i.id)).toEqual(['model', 'in', 'cache', 'out', 'cost'])
  })
})
