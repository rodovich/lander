import { useEffect, useMemo, useState } from 'react'
import { loadStats } from './api'
import { BarChart, HeatmapChart, type SeriesColor } from './charts'
import { PanelHeader } from './panelHeader'
import { SegmentedControl } from './segmentedControl'
import {
  buildStats,
  OTHER_KEY,
  UNREPORTED_KEY,
  type StatsFacts,
  type StatsRange,
} from './stats'

// The stats dashboard: bar charts and heatmaps of what the task corpus
// records, over a chosen range, for the navbar's project or all of them.

const RANGE_OPTIONS: { value: StatsRange; label: string }[] = [
  { value: '7d', label: '7d' },
  { value: '13w', label: '13w' },
  { value: '12m', label: '12m' },
]

// Launches wear the riding accent and landings the landed one, as the task
// statuses do; turns, the neutral.
const LAUNCH_COLOR = 'var(--riding)'
const LAND_COLOR = 'var(--landed)'
const TURN_COLOR = 'var(--muted)'

// The categorical slots for a ranked breakdown, in fixed order, one per named
// series by its rank; and the neutrals for the series that end it.
const SLOT_COLORS = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#4a3aa7',
  '#e34948',
]
const OTHER_COLOR = '#898781'
const UNREPORTED_COLOR = '#c3c2b7'

const taskColor: SeriesColor = (s) => (s.key === 'landed' ? LAND_COLOR : LAUNCH_COLOR)
const turnColor: SeriesColor = () => TURN_COLOR
const rankedColor: SeriesColor = (s, i) =>
  s.key === OTHER_KEY
    ? OTHER_COLOR
    : s.key === UNREPORTED_KEY
      ? UNREPORTED_COLOR
      : SLOT_COLORS[i % SLOT_COLORS.length]

export function StatsPanel({
  slug,
  projectName,
  onClose,
}: {
  slug: string
  projectName: string
  onClose: () => void
}) {
  const [facts, setFacts] = useState<StatsFacts | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [range, setRange] = useState<StatsRange>('7d')
  const [scope, setScope] = useState<'project' | 'all'>('project')

  useEffect(() => {
    let live = true
    loadStats().then(
      (loaded) => live && setFacts(loaded),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      live = false
    }
  }, [])

  const view = useMemo(
    () =>
      facts &&
      buildStats(facts, {
        range,
        project: scope === 'all' ? null : slug,
        now: new Date(),
      }),
    [facts, range, scope, slug],
  )

  return (
    <>
      <PanelHeader title="Stats" onClose={onClose}>
        <SegmentedControl
          label="Range"
          value={range}
          onChange={setRange}
          options={RANGE_OPTIONS}
        />
        <SegmentedControl
          label="Projects"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'project', label: projectName },
            { value: 'all', label: 'All projects' },
          ]}
        />
      </PanelHeader>
      {error && <div className="error">{error}</div>}
      {!view && !error && <div className="placeholder">Loading…</div>}
      {view && (
        <div className="stats-grid">
          <BarChart title="Tasks" data={view.tasks} color={taskColor} layout="grouped" />
          <BarChart title="Turns" data={view.turns} color={turnColor} />
          <BarChart title="Tasks by agent" data={view.agents} color={rankedColor} />
          <BarChart title="Turns by model" data={view.models} color={rankedColor} />
          <BarChart title="Thinking time" data={view.workingHours} color={turnColor} />
          <BarChart title="API cost" data={view.cost} color={turnColor} />
          <HeatmapChart
            title="Tasks launched by hour and weekday"
            grid={view.heatmaps.launches}
            color={LAUNCH_COLOR}
            noun={{ one: 'launched', other: 'launched' }}
          />
          <HeatmapChart
            title="Tasks landed by hour and weekday"
            grid={view.heatmaps.landings}
            color={LAND_COLOR}
            noun={{ one: 'landed', other: 'landed' }}
          />
          <HeatmapChart
            title="Turns by hour and weekday"
            grid={view.heatmaps.turns}
            color={TURN_COLOR}
            noun={{ one: 'turn', other: 'turns' }}
          />
        </div>
      )}
    </>
  )
}
