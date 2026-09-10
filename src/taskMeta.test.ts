import { describe, expect, it } from 'vitest'
import {
  latestUpdateAt,
  latestUsageRide,
  rideElapsedMs,
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

// 12:00:00 → the `now` every open-ride case below is measured against.
const NOW = Date.parse('2026-09-09T12:00:00.000Z')

describe('rideElapsedMs', () => {
  it('reports a settled ride’s measurement, ignoring the span it was open for', () => {
    const ride: Ride = {
      id: 'r1',
      startedAt: '2026-09-09T11:00:00.000Z',
      endedAt: '2026-09-09T11:40:00.000Z',
      outcome: 'done',
      durationMs: 65_000,
    }
    expect(rideElapsedMs(ride, NOW)).toBe(65_000)
  })

  it('reports nothing for a settled ride that was never measured', () => {
    // The boot-recovery / lost-run shape: closed by the server, so `endedAt`
    // exists but carries the moment of the close, which is not a duration.
    expect(
      rideElapsedMs(
        {
          id: 'r1',
          startedAt: '2026-09-09T11:00:00.000Z',
          endedAt: '2026-09-09T11:40:00.000Z',
          outcome: 'error',
        },
        NOW,
      ),
    ).toBeUndefined()
  })

  it('estimates an open ride from its start', () => {
    expect(
      rideElapsedMs({ id: 'r1', startedAt: '2026-09-09T11:58:30.000Z' }, NOW),
    ).toBe(90_000)
  })
})

describe('totalRideMs', () => {
  it('sums the rides it can time and skips the ones it cannot', () => {
    const total = totalRideMs(
      withRides([
        { id: 'r1', startedAt: '…', endedAt: '…', durationMs: 10_000 },
        // Untimed: contributes nothing rather than voiding the sum.
        { id: 'r2', startedAt: '…', endedAt: '…' },
        { id: 'r3', startedAt: '…', endedAt: '…', durationMs: 5_000 },
      ]),
      NOW,
    )
    expect(total).toBe(15_000)
  })

  it('counts the in-flight ride, so the total climbs during a turn', () => {
    const total = totalRideMs(
      withRides([
        { id: 'r1', startedAt: '2026-09-09T10:00:00.000Z', endedAt: '…', durationMs: 60_000 },
        { id: 'r2', startedAt: '2026-09-09T11:59:00.000Z' },
      ]),
      NOW,
    )
    expect(total).toBe(120_000)
  })

  it('is undefined when no ride can be timed at all', () => {
    expect(
      totalRideMs(withRides([{ id: 'r1', startedAt: '…', endedAt: '…' }]), NOW),
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
