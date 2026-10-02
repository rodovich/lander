import { describe, it, expect } from 'vitest'
import { taskKeyOf } from './taskRef'
import { dwellTarget } from './useReadMarker'
import type { TaskWithProject } from './types'

// The pure dwell policy: which marker, if any, the open task should advance to
// once the pane's measurement has held. Timestamps only need to order
// lexicographically.
const T1 = '2026-06-26T10:00:00.000Z'
const T2 = '2026-06-26T10:01:00.000Z'

const task = (readThrough?: string) =>
  ({ id: 'a', projectSlug: 'p', readThrough }) as TaskWithProject
const KEY = taskKeyOf(task())

describe('dwellTarget', () => {
  it('advances to a measurement past the task’s marker', () => {
    expect(
      dwellTarget({
        current: task(T1),
        readUpTo: { key: KEY, at: T2 },
        tabActive: true,
      }),
    ).toBe(T2)
  })

  it('advances a task with no marker yet', () => {
    expect(
      dwellTarget({
        current: task(),
        readUpTo: { key: KEY, at: T1 },
        tabActive: true,
      }),
    ).toBe(T1)
  })

  it('holds a measurement at or behind the marker', () => {
    for (const at of [T1, '']) {
      expect(
        dwellTarget({
          current: task(T1),
          readUpTo: { key: KEY, at },
          tabActive: true,
        }),
      ).toBeNull()
    }
  })

  it('holds while the tab is inactive', () => {
    expect(
      dwellTarget({
        current: task(T1),
        readUpTo: { key: KEY, at: T2 },
        tabActive: false,
      }),
    ).toBeNull()
  })

  it('ignores a measurement of another task', () => {
    expect(
      dwellTarget({
        current: task(T1),
        readUpTo: { key: taskKeyOf({ ...task(), id: 'b' }), at: T2 },
        tabActive: true,
      }),
    ).toBeNull()
  })
})
