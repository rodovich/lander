// The stats dashboard's arithmetic: the server serves raw facts (see
// server/stats.ts), and this buckets them into the viewer's local days, weeks,
// and months, in the generic shapes the charts draw. Pure over an injected
// `now`, so the calendar edges are testable. Colors are the panel's call.

import type { BarData, ChartSeries, HeatGrid } from './charts'
import { formatCost, formatHoursMinutes } from './format'

// The last 7 complete days, 13 complete weeks, or 12 complete months, each
// plus the one in progress.
export type StatsRange = '7d' | '13w' | '12m'

export type StatsFacts = {
  recordedSince: { events: string; turns: string; workingTime: string }
  tasks: {
    project: string
    flow: string
    launchedAt?: string
    landedAt: string[]
  }[]
  turns: {
    project: string
    flow: string
    startedAt: string
    model?: string
    durationMs?: number
    costUsd?: number
  }[]
}

// One bar's span of time, as local-midnight epoch ms. `partial` marks the
// period still in progress, which the chart hatches.
export type Bucket = {
  start: number
  end: number
  partial: boolean
  // The axis label, and the fuller name the tooltip leads with.
  label: string
  title: string
}

export type StatsView = {
  buckets: Bucket[]
  tasks: BarData
  turns: BarData
  agents: BarData
  models: BarData
  workingHours: BarData
  cost: BarData
  heatmaps: { turns: HeatGrid; launches: HeatGrid; landings: HeatGrid }
}

// The keys of the series a ranked breakdown ends with, past its named ones:
// the folded tail, and the records that carried no name at all.
export const OTHER_KEY = '\0other'
export const UNREPORTED_KEY = '\0unreported'

// A ranked breakdown past this many named series folds its tail into "Other".
export const MAX_NAMED = 7

const noun = (one: string, other = one): ChartSeries['readout'] => ({ one, other })

const day = (y: number, m: number, d: number) => new Date(y, m, d).getTime()

export function startOfDay(ms: number): number {
  const d = new Date(ms)
  return day(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(ms: number, n: number): number {
  const d = new Date(ms)
  return day(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

// Weeks run Sunday through Saturday.
function startOfWeek(ms: number): number {
  return addDays(startOfDay(ms), -new Date(ms).getDay())
}

const fmt = (ms: number, opts: Intl.DateTimeFormatOptions) =>
  new Date(ms).toLocaleDateString(undefined, opts)

export function statsBuckets(range: StatsRange, now: Date): Bucket[] {
  const today = startOfDay(now.getTime())
  const buckets: Bucket[] = []
  if (range === '7d') {
    for (let start = addDays(today, -7); start <= today; start = addDays(start, 1)) {
      const partial = start === today
      buckets.push({
        start,
        end: addDays(start, 1),
        partial,
        label: partial ? 'Today' : fmt(start, { weekday: 'short', day: 'numeric' }),
        title:
          fmt(start, { weekday: 'long', month: 'short', day: 'numeric' }) +
          (partial ? ' (so far)' : ''),
      })
    }
  } else if (range === '13w') {
    const current = startOfWeek(today)
    for (let i = 13; i >= 0; i--) {
      const start = addDays(current, -7 * i)
      buckets.push({
        start,
        end: addDays(start, 7),
        partial: i === 0,
        label: fmt(start, { month: 'short', day: 'numeric' }),
        title:
          `Week of ${fmt(start, { month: 'short', day: 'numeric' })}` +
          (i === 0 ? ' (so far)' : ''),
      })
    }
  } else {
    const d = new Date(today)
    for (let i = 12; i >= 0; i--) {
      const start = day(d.getFullYear(), d.getMonth() - i, 1)
      const s = new Date(start)
      buckets.push({
        start,
        end: day(s.getFullYear(), s.getMonth() + 1, 1),
        partial: i === 0,
        label: fmt(start, { month: 'short' }),
        title:
          fmt(start, { month: 'long', year: 'numeric' }) + (i === 0 ? ' (so far)' : ''),
      })
    }
  }
  return buckets
}

// A fact to tally: when it happened, which series it counts toward, and how
// much (1 for a count, hours for working time, dollars for cost).
type Fact = { at: number; series: number; weight: number }

// Sum facts into buckets. A day counts only if it began at or after `since`,
// so the partial day a recording started on is left out along with everything
// before it; a bucket that ends before `since` has no recorded day at all.
function tally(
  buckets: Bucket[],
  seriesCount: number,
  since: number,
  facts: Fact[],
): (number[] | null)[] {
  const values = buckets.map((b) =>
    b.end > since ? new Array<number>(seriesCount).fill(0) : null,
  )
  for (const fact of facts) {
    if (startOfDay(fact.at) < since) continue
    const i = buckets.findIndex((b) => fact.at >= b.start && fact.at < b.end)
    if (i >= 0) values[i]![fact.series] += fact.weight
  }
  return values
}

// The first local midnight at or after an instant: the first day a recording
// that began mid-day covers whole.
function firstWholeDay(iso: string): number {
  const ms = Date.parse(iso)
  const start = startOfDay(ms)
  return start === ms ? start : addDays(start, 1)
}

// Names — flows, models, whatever the records carry — ranked by count over the
// whole corpus, not the current filter, so a series keeps its place (and so its
// color) when the project or range changes. Labeled verbatim: nothing here
// knows one name from another.
function rankSeries(
  counts: Map<string, number>,
): { series: ChartSeries[]; indexOf: (key: string) => number } {
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key)
  const named = ranked.length > MAX_NAMED + 1 ? ranked.slice(0, MAX_NAMED) : ranked
  const series: ChartSeries[] = named.map((key) => ({ key, label: key }))
  const folded = named.length < ranked.length
  if (folded) series.push({ key: OTHER_KEY, label: 'Other', readout: noun('other') })
  const index = new Map(named.map((key, i) => [key, i]))
  return {
    series,
    indexOf: (key) => index.get(key) ?? series.length - 1,
  }
}

const countBy = <T>(items: T[], key: (item: T) => string | undefined) => {
  const counts = new Map<string, number>()
  for (const item of items) {
    const k = key(item)
    if (k !== undefined) counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return counts
}

// Count instants on a Sunday-first weekday × hour grid, keeping those within
// the range and on days recorded since `since`.
function heatmapOf(times: number[], since: number, from: number, to: number): HeatGrid {
  const heatmap: HeatGrid = {
    cells: Array.from({ length: 7 }, () => new Array<number>(24).fill(0)),
    max: 0,
  }
  for (const ms of times) {
    if (ms < from || ms > to || startOfDay(ms) < since) continue
    const d = new Date(ms)
    const row = heatmap.cells[d.getDay()]
    row[d.getHours()]++
    heatmap.max = Math.max(heatmap.max, row[d.getHours()])
  }
  return heatmap
}

export function buildStats(
  facts: StatsFacts,
  { range, project, now }: { range: StatsRange; project: string | null; now: Date },
): StatsView {
  const nowMs = now.getTime()
  const buckets = statsBuckets(range, now)
  const rangeStart = buckets[0].start
  const eventsFrom = firstWholeDay(facts.recordedSince.events)
  const turnsFrom = firstWholeDay(facts.recordedSince.turns)
  const workFrom = firstWholeDay(facts.recordedSince.workingTime)
  const chart = (series: ChartSeries[], since: number, list: Fact[]): BarData => {
    const values = tally(buckets, series.length, since, list)
    return {
      series,
      columns: buckets.map((b, i) => ({
        key: b.start,
        label: b.label,
        title: b.title,
        partial: b.partial,
        values: values[i],
      })),
    }
  }

  const inProject = <T extends { project: string }>(list: T[]) =>
    project === null ? list : list.filter((f) => f.project === project)
  const tasks = inProject(facts.tasks)
  const turns = inProject(facts.turns).filter(
    (t) => Date.parse(t.startedAt) >= Date.parse(facts.recordedSince.turns),
  )

  // Launched and landed. A task landed twice in a day lands once that day.
  const taskFacts: Fact[] = []
  for (const t of tasks) {
    if (t.launchedAt)
      taskFacts.push({ at: Date.parse(t.launchedAt), series: 0, weight: 1 })
    const days = new Set<number>()
    for (const at of t.landedAt) {
      const ms = Date.parse(at)
      if (days.has(startOfDay(ms))) continue
      days.add(startOfDay(ms))
      taskFacts.push({ at: ms, series: 1, weight: 1 })
    }
  }

  const flows = rankSeries(
    countBy(facts.tasks, (t) => (t.launchedAt ? t.flow : undefined)),
  )
  const models = rankSeries(
    countBy(
      facts.turns.filter(
        (t) => Date.parse(t.startedAt) >= Date.parse(facts.recordedSince.turns),
      ),
      (t) => t.model,
    ),
  )
  const unreported = models.series.length
  const modelSeries = [
    ...models.series,
    { key: UNREPORTED_KEY, label: 'Not reported', readout: noun('not reported') },
  ]

  const timesOf = (series: number) =>
    taskFacts.filter((f) => f.series === series).map((f) => f.at)
  const heatmap = (times: number[], since: number) =>
    heatmapOf(times, since, rangeStart, nowMs)

  return {
    buckets,
    tasks: chart(
      [
        { key: 'launched', label: 'Launched', readout: noun('launched') },
        { key: 'landed', label: 'Landed', readout: noun('landed') },
      ],
      eventsFrom,
      taskFacts,
    ),
    turns: chart(
      [{ key: 'turns', label: 'Turns', readout: noun('turn', 'turns') }],
      turnsFrom,
      turns.map((t) => ({ at: Date.parse(t.startedAt), series: 0, weight: 1 })),
    ),
    agents: chart(
      flows.series,
      eventsFrom,
      tasks.flatMap((t) =>
        t.launchedAt
          ? [{ at: Date.parse(t.launchedAt), series: flows.indexOf(t.flow), weight: 1 }]
          : [],
      ),
    ),
    models: chart(
      modelSeries,
      turnsFrom,
      turns.map((t) => ({
        at: Date.parse(t.startedAt),
        series: t.model ? models.indexOf(t.model) : unreported,
        weight: 1,
      })),
    ),
    workingHours: chart(
      [{ key: 'hours', label: 'Hours', format: (h) => formatHoursMinutes(h * 3_600_000) }],
      workFrom,
      turns.flatMap((t) =>
        t.durationMs != null
          ? [{ at: Date.parse(t.startedAt), series: 0, weight: t.durationMs / 3_600_000 }]
          : [],
      ),
    ),
    cost: chart(
      [{ key: 'cost', label: 'Cost', format: formatCost }],
      turnsFrom,
      turns.flatMap((t) =>
        t.costUsd != null
          ? [{ at: Date.parse(t.startedAt), series: 0, weight: t.costUsd }]
          : [],
      ),
    ),
    heatmaps: {
      turns: heatmap(
        turns.map((t) => Date.parse(t.startedAt)),
        turnsFrom,
      ),
      launches: heatmap(timesOf(0), eventsFrom),
      landings: heatmap(timesOf(1), eventsFrom),
    },
  }
}
