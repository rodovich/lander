import { describe, it, expect } from 'vitest'
import { idleSeenDwell, stepSeenDwell } from './useSeenMarker'
import type { SeenDwellState } from './useSeenMarker'

// The pure seen-marker rules, stepped through the viewing sequences the hook
// feeds them. Timestamps only need to order lexicographically.
const T1 = '2026-06-26T10:00:00.000Z'
const T2 = '2026-06-26T10:01:00.000Z'
const T3 = '2026-06-26T10:02:00.000Z'

const viewing = (taskId: string | null, latest: string) => ({
  taskId,
  activelyViewing: taskId !== null,
  latest,
})
const away = (taskId: string | null = null, latest = '') => ({
  taskId,
  activelyViewing: false,
  latest,
})

describe('stepSeenDwell', () => {
  it('stays idle while nothing is actively viewed', () => {
    const { state, action } = stepSeenDwell(idleSeenDwell, away())
    expect(action).toBe('idle')
    expect(state).toEqual(idleSeenDwell)
  })

  it('arms the dwell when viewing begins, snapshotting the baseline', () => {
    const { state, action } = stepSeenDwell(idleSeenDwell, viewing('a', T1))
    expect(action).toBe('arm')
    expect(state).toEqual({ taskId: 'a', baseline: T1 })
  })

  it('cancels a glance that does not last (arm → idle, never mark)', () => {
    const armed = stepSeenDwell(idleSeenDwell, viewing('a', T1)).state
    // The tab blurs (or the reader scrolls up) before the dwell elapses; the
    // task stays open but is no longer actively viewed.
    const { state, action } = stepSeenDwell(armed, away('a', T1))
    expect(action).toBe('idle')
    expect(state).toEqual(idleSeenDwell)
  })

  it('marks at once when an update lands while actively viewing, advancing the baseline', () => {
    const armed = stepSeenDwell(idleSeenDwell, viewing('a', T1)).state
    const first = stepSeenDwell(armed, viewing('a', T2))
    expect(first.action).toBe('mark')
    expect(first.state.baseline).toBe(T2)
    // The same update seen again holds; only a strictly newer one re-marks.
    expect(stepSeenDwell(first.state, viewing('a', T2)).action).toBe('hold')
    expect(stepSeenDwell(first.state, viewing('a', T3)).action).toBe('mark')
  })

  it('holds on an unchanged or stale latest', () => {
    const armed: SeenDwellState = { taskId: 'a', baseline: T2 }
    expect(stepSeenDwell(armed, viewing('a', T2)).action).toBe('hold')
    // A stale/older value (e.g. a poll racing an optimistic update) never
    // marks nor moves the baseline back.
    const stale = stepSeenDwell(armed, viewing('a', T1))
    expect(stale.action).toBe('hold')
    expect(stale.state.baseline).toBe(T2)
  })

  it('re-arms with a fresh baseline when the viewer switches tasks', () => {
    const onA = stepSeenDwell(idleSeenDwell, viewing('a', T1)).state
    const { state, action } = stepSeenDwell(onA, viewing('b', T2))
    expect(action).toBe('arm')
    expect(state).toEqual({ taskId: 'b', baseline: T2 })
  })

  it('re-arms (not marks) when viewing resumes after a break, even with a newer update', () => {
    // Viewed at T1, looked away, an update landed (T2), then looked back: the
    // update predates the return, so it clears only via the fresh dwell.
    const armed = stepSeenDwell(idleSeenDwell, viewing('a', T1)).state
    const idle = stepSeenDwell(armed, away('a', T2)).state
    const back = stepSeenDwell(idle, viewing('a', T2))
    expect(back.action).toBe('arm')
    expect(back.state.baseline).toBe(T2)
  })
})
