import { describe, expect, it } from 'vitest'
import {
  firstUnreadIndex,
  isUnread,
  readStamps,
  readThroughOf,
  unreadMarker,
} from './readMarker'
import type { Item, Ride, Task } from './types'

const t = (n: number) => `2026-08-21T20:0${n}:00.000Z`

const task = (over: Partial<Task> = {}): Task => ({
  id: 'x',
  title: 'X',
  status: 'paced',
  createdAt: t(0),
  items: [],
  rides: [],
  ...over,
})

const own = (id: string, at: string): Item => ({
  id,
  at,
  kind: 'message',
  role: 'user',
  text: id,
})
const flow = (id: string, rideId: string, at: string): Item => ({
  id,
  at,
  rideId,
  kind: 'message',
  role: 'flow',
  text: id,
})
const ride = (id: string, startedAt: string, endedAt?: string): Ride =>
  ({ id, startedAt, ...(endedAt ? { endedAt } : {}) }) as Ride

// you (0) → turn r1 (1–2) → you (3) → turn r2 (4–5)
const conversation = (readThrough?: string) =>
  task({
    readThrough,
    items: [own('u1', t(0)), flow('f1', 'r1', t(1)), own('u2', t(3)), flow('f2', 'r2', t(4))],
    rides: [ride('r1', t(1), t(2)), ride('r2', t(4), t(5))],
  })

describe('readStamps', () => {
  it('stamps a settled turn by its end and skips the human’s own messages', () => {
    expect(readStamps(conversation())).toEqual([null, t(2), null, t(5)])
  })

  it('skips the open turn until it lands', () => {
    const c = conversation()
    c.rides = [ride('r1', t(1), t(2)), ride('r2', t(4))]
    expect(readStamps(c)).toEqual([null, t(2), null, null])
  })

  it('does not count the acting task’s own task-action row', () => {
    const c = task({
      items: [
        {
          id: 'a1',
          at: t(1),
          kind: 'task-action',
          action: 'launch',
          target: { id: 'child', projectSlug: 'proj' },
        } as Item,
      ],
    })
    expect(readStamps(c)).toEqual([null])
  })
})

describe('firstUnreadIndex', () => {
  it('finds the first entry stamped after the marker', () => {
    expect(firstUnreadIndex(conversation(t(3)))).toBe(3)
    expect(firstUnreadIndex(conversation(''))).toBe(1)
  })

  it('reads a caught-up task, and one with no marker, as read', () => {
    expect(firstUnreadIndex(conversation(t(5)))).toBe(-1)
    expect(isUnread(conversation(t(5)))).toBe(false)
    expect(isUnread(conversation())).toBe(false)
  })

  it('re-surfaces a turn read mid-stream once it lands later', () => {
    // Read through t(4) while r2 streamed; it ended at t(5).
    expect(isUnread(conversation(t(4)))).toBe(true)
  })
})

describe('readThroughOf', () => {
  it('takes the newest stamp of the prefix, ignoring nulls', () => {
    expect(readThroughOf([null, t(2), null, t(5)], 0)).toBe('')
    expect(readThroughOf([null, t(2), null, t(5)], 3)).toBe(t(2))
    expect(readThroughOf([t(3), t(1)], 2)).toBe(t(3))
  })
})

describe('unreadMarker', () => {
  it('marks what followed the human’s last message unread', () => {
    const c = conversation(t(5))
    const at = unreadMarker(c)!
    expect(firstUnreadIndex({ ...c, readThrough: at })).toBe(3)
  })

  it('falls back to the last entry when nothing followed the human', () => {
    const c = conversation(t(5))
    c.items!.push(own('u3', t(6)))
    const at = unreadMarker(c)!
    expect(firstUnreadIndex({ ...c, readThrough: at })).toBe(3)
  })

  it('is null for a task with nothing that could be unread', () => {
    expect(unreadMarker(task({ items: [own('u1', t(0))] }))).toBeNull()
  })
})
