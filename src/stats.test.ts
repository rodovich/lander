import { describe, it, expect } from 'vitest'
import type { BarData } from './charts'
import { buildStats, statsBuckets, type StatsFacts } from './stats'

// Each column's values, in order.
const vals = (data: BarData) => data.columns.map((c) => c.values)

// Local-time instants, so the suite holds in any time zone.
const at = (m: number, d: number, h = 12, y = 2026) => new Date(y, m - 1, d, h)
const iso = (m: number, d: number, h = 12, y = 2026) => at(m, d, h, y).toISOString()
const day = (m: number, d: number, y = 2026) => at(m, d, 0, y).getTime()

// Tuesday, Sep 29 2026, mid-afternoon.
const NOW = at(9, 29, 15)

const facts = (over: Partial<StatsFacts> = {}): StatsFacts => ({
  recordedSince: { events: iso(1, 1, 0), turns: iso(1, 1, 0), workingTime: iso(1, 1, 0) },
  tasks: [],
  turns: [],
  ...over,
})

describe('statsBuckets', () => {
  it('gives a week as the last 7 complete days plus today', () => {
    const b = statsBuckets('7d', NOW)
    expect(b).toHaveLength(8)
    expect(b[0].start).toBe(day(9, 22))
    expect(b[7].start).toBe(day(9, 29))
    expect(b.map((x) => x.partial)).toEqual([...new Array(7).fill(false), true])
    expect(b[7].label).toBe('Today')
    expect(b[7].title).toMatch(/ \(so far\)$/)
  })

  it('gives a quarter as 13 complete Sunday–Saturday weeks plus the current one', () => {
    const b = statsBuckets('13w', NOW)
    expect(b).toHaveLength(14)
    expect(b[13].start).toBe(day(9, 27))
    expect(new Date(b[0].start).getDay()).toBe(0)
    expect(b[0].start).toBe(day(6, 28))
    expect(b[13].partial).toBe(true)
  })

  it('gives a year as 12 complete months plus the current one', () => {
    const b = statsBuckets('12m', NOW)
    expect(b).toHaveLength(13)
    expect(b[0].start).toBe(day(9, 1, 2025))
    expect(b[12].start).toBe(day(9, 1))
    expect(b[12].end).toBe(day(10, 1))
  })
})

describe('buildStats', () => {
  it('counts launched tasks and landings per day, one landing per task per day', () => {
    const view = buildStats(
      facts({
        tasks: [
          { project: 'p', flow: 'claude', launchedAt: iso(9, 28), landedAt: [iso(9, 28, 13), iso(9, 28, 14), iso(9, 29)] },
          { project: 'p', flow: 'codex', launchedAt: iso(9, 28), landedAt: [] },
        ],
      }),
      { range: '7d', project: null, now: NOW },
    )
    expect(vals(view.tasks)[6]).toEqual([2, 1])
    expect(vals(view.tasks)[7]).toEqual([0, 1])
  })

  it('leaves days before a recording began, and the partial day it began on, unrecorded', () => {
    const view = buildStats(
      facts({
        recordedSince: { events: iso(1, 1, 0), turns: iso(9, 25, 10), workingTime: iso(1, 1, 0) },
        turns: [
          { project: 'p', flow: 'claude', startedAt: iso(9, 25, 11) },
          { project: 'p', flow: 'claude', startedAt: iso(9, 26) },
        ],
      }),
      { range: '7d', project: null, now: NOW },
    )
    // Sep 22–25 unrecorded; Sep 26 is the first whole day.
    expect(vals(view.turns).slice(0, 4)).toEqual([null, null, null, null])
    expect(vals(view.turns)[4]).toEqual([1])
  })

  it('sums each week of a quarter', () => {
    const view = buildStats(
      facts({
        turns: [
          ...new Array(14).fill(0).map(() => ({ project: 'p', flow: 'claude', startedAt: iso(9, 22) })),
          // Saturday closes the week; Sunday opens the next.
          { project: 'p', flow: 'claude', startedAt: iso(9, 26) },
          { project: 'p', flow: 'claude', startedAt: iso(9, 27) },
          ...new Array(3).fill(0).map(() => ({ project: 'p', flow: 'claude', startedAt: iso(9, 29) })),
        ],
      }),
      { range: '13w', project: null, now: NOW },
    )
    expect(vals(view.turns)[12]).toEqual([15])
    expect(vals(view.turns)[13]).toEqual([4])
  })

  it('narrows to one project without recoloring the series', () => {
    const f = facts({
      tasks: [
        { project: 'a', flow: 'claude', launchedAt: iso(9, 28), landedAt: [] },
        { project: 'a', flow: 'claude', launchedAt: iso(9, 28), landedAt: [] },
        { project: 'b', flow: 'codex', launchedAt: iso(9, 28), landedAt: [] },
      ],
    })
    const all = buildStats(f, { range: '7d', project: null, now: NOW })
    const onlyB = buildStats(f, { range: '7d', project: 'b', now: NOW })
    expect(vals(all.agents)[6]).toEqual([2, 1])
    expect(vals(onlyB.agents)[6]).toEqual([0, 1])
    expect(onlyB.agents.series).toEqual(all.agents.series)
  })

  it('stacks turns by model, named as reported, with unreported models kept apart', () => {
    const view = buildStats(
      facts({
        turns: [
          { project: 'p', flow: 'claude', startedAt: iso(9, 28), model: 'claude-opus-5' },
          { project: 'p', flow: 'codex', startedAt: iso(9, 28) },
        ],
      }),
      { range: '7d', project: null, now: NOW },
    )
    expect(view.models.series.map((s) => s.label)).toEqual(['claude-opus-5', 'Not reported'])
    expect(vals(view.models)[6]).toEqual([1, 1])
  })

  it('sums working time in hours', () => {
    const view = buildStats(
      facts({
        turns: [
          { project: 'p', flow: 'claude', startedAt: iso(9, 28), durationMs: 1_800_000 },
          { project: 'p', flow: 'claude', startedAt: iso(9, 28), durationMs: 5_400_000 },
          { project: 'p', flow: 'claude', startedAt: iso(9, 28) },
        ],
      }),
      { range: '7d', project: null, now: NOW },
    )
    expect(vals(view.workingHours)[6]).toEqual([2])
  })

  it('sums the cost of the turns that report one', () => {
    const view = buildStats(
      facts({
        turns: [
          { project: 'p', flow: 'claude', startedAt: iso(9, 28), costUsd: 0.25 },
          { project: 'p', flow: 'claude', startedAt: iso(9, 28), costUsd: 1.5 },
          { project: 'p', flow: 'codex', startedAt: iso(9, 28) },
        ],
      }),
      { range: '7d', project: null, now: NOW },
    )
    expect(vals(view.cost)[6]).toEqual([1.75])
  })

  it('maps turns onto a Sunday-first hour grid within the range', () => {
    const view = buildStats(
      facts({
        turns: [
          { project: 'p', flow: 'claude', startedAt: iso(9, 28, 9) },
          { project: 'p', flow: 'claude', startedAt: iso(9, 28, 9) },
          { project: 'p', flow: 'claude', startedAt: iso(9, 27, 23) },
          // Before the week range.
          { project: 'p', flow: 'claude', startedAt: iso(9, 1, 9) },
        ],
      }),
      { range: '7d', project: null, now: NOW },
    )
    const turns = view.heatmaps.turns
    expect(turns.cells[1][9]).toBe(2)
    expect(turns.cells[0][23]).toBe(1)
    expect(turns.max).toBe(2)
    expect(turns.cells.flat().reduce((a, b) => a + b, 0)).toBe(3)
  })

  it('maps launches and landings onto their own grids', () => {
    const view = buildStats(
      facts({
        tasks: [
          { project: 'p', flow: 'claude', launchedAt: iso(9, 28, 9), landedAt: [iso(9, 29, 14)] },
        ],
      }),
      { range: '7d', project: null, now: NOW },
    )
    expect(view.heatmaps.launches.cells[1][9]).toBe(1)
    expect(view.heatmaps.landings.cells[2][14]).toBe(1)
    expect(view.heatmaps.launches.cells.flat().reduce((a, b) => a + b, 0)).toBe(1)
  })
})
