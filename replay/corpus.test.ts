// Truncation is the property that silently invalidates every other number if it
// is got wrong: a body that can see past its own fire scores well on gates that
// look forward, and there is no symptom.

import { describe, expect, it } from 'vitest'
import { truncateAt } from './corpus'
import type { Item, Ride } from '../server/tasks'

const AT = (n: number): string =>
  new Date(Date.parse('2026-01-01T00:00:00.000Z') + n * 1000).toISOString()

const user = (n: number): Item =>
  ({ id: `u${n}`, at: AT(n), kind: 'message', role: 'user', text: 'go' }) as Item
const flow = (n: number, rideId: string): Item =>
  ({ id: `f${n}`, at: AT(n), kind: 'message', role: 'flow', rideId, text: 'ok' }) as Item
const event = (n: number, eventKind: string): Item =>
  ({ id: `e${n}`, at: AT(n), kind: 'event', eventKind }) as Item

const ride = (id: string, from: number, to?: number): Ride =>
  ({
    id,
    startedAt: AT(from),
    ...(to === undefined ? {} : { endedAt: AT(to), outcome: 'done' }),
    usage: { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 },
  }) as Ride

// A task that lands at index 3 and then keeps going: a second instruction, a
// second ride, and a reopening — all of it the landing's future.
const task = () => ({
  id: 'tsk-1',
  title: 'Later work',
  status: 'riding',
  flow: 'claude',
  items: [
    user(0),
    flow(1, 'r1'),
    event(2, 'landed'),
    event(3, 'unlanded'),
    user(4),
    flow(5, 'r2'),
  ],
  rides: [ride('r1', 0, 6), ride('r2', 4, 6)],
  queued: ['something later'],
})

describe('truncateAt', () => {
  it('cuts at the event, inclusive, so the body cannot see its own future', () => {
    const t = truncateAt(task(), 2)
    expect(t.items?.map((i) => i.id)).toEqual(['u0', 'f1', 'e2'])
  })

  it('re-opens a ride that had not ended at the fire', () => {
    const t = truncateAt(task(), 2)
    // r2 had not started; r1 was still open at the landing, so its end, outcome
    // and usage are stripped — `openRide` has to answer what the live fire would.
    expect(t.rides?.map((r) => r.id)).toEqual(['r1'])
    expect(t.rides?.[0].endedAt).toBeUndefined()
    expect(t.rides?.[0].outcome).toBeUndefined()
    expect(t.rides?.[0].usage).toBeUndefined()
  })

  it('leaves a ride that had already closed alone', () => {
    const t = truncateAt(
      { ...task(), rides: [ride('r1', 0, 1)] },
      2,
    )
    expect(t.rides?.[0].endedAt).toBe(AT(1))
    expect(t.rides?.[0].outcome).toBe('done')
  })

  // The STORED status, not the served one: publicTask re-derives the served
  // value from the open ride, and would overwrite anything written as one.
  it('replays the stored status from the crossings up to the cut', () => {
    expect(truncateAt(task(), 1).status).toBe('riding')
    expect(truncateAt(task(), 2).status).toBe('landed')
    // The reopening is in view at index 3, so the task reads riding again.
    expect(truncateAt(task(), 3).status).toBe('riding')
  })

  it('empties the queue, which is not recoverable', () => {
    expect(truncateAt(task(), 2).queued).toEqual([])
  })
})
