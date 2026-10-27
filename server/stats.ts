// The facts the stats dashboard graphs, projected from every task record in
// every configured project — active and archived alike. The server only
// projects; bucketing by day, week, or month happens in the browser, which is
// the one place that knows the viewer's time zone.
//
// A projection is kept per file (retainedProjection), holding only the handful
// of fields a chart reads rather than the whole parse: the archive runs to
// hundreds of megabytes of conversations.

import type { Project } from './projects'
import { retainedProjection, type Projected } from './store'
import { taskFlow, type Item, type Ride } from './tasks'

export type StatsTask = {
  project: string
  flow: string
  // When the task first launched: its first `launched` event, which for a
  // task scheduled ahead is its delivery rather than its creation. Absent on a
  // task that never launched.
  launchedAt?: string
  // Every crossing into `landed`, in order. A task landed, reopened, and
  // landed again carries two.
  landedAt: string[]
}

export type StatsTurn = {
  project: string
  flow: string
  startedAt: string
  // The model the provider reported for the turn, when it reported one.
  model?: string
  // How long the run worked, as the daemon measured it.
  durationMs?: number
  // The turn's dollar cost, from providers that report one (Claude).
  costUsd?: number
}

// When each fact began being recorded in the form it has today. Anything
// before is either absent or was synthesized by a migration, so the dashboard
// shows it as unrecorded rather than graphing it:
//   - events: `launched`/`landed` events, since 4facfc8.
//   - turns: ride records, since 4393e1c. Rides before it were derived from
//     assistant messages by the v1→v2 migration.
//   - workingTime: `Ride.durationMs`, since dccd9db.
export const RECORDED_SINCE = {
  events: '2026-06-17T15:01:41Z',
  turns: '2026-07-11T00:37:08Z',
  workingTime: '2026-09-10T04:08:33Z',
} as const

export type StatsFacts = {
  recordedSince: typeof RECORDED_SINCE
  tasks: StatsTask[]
  turns: StatsTurn[]
}

type Projection = { task: StatsTask; turns: StatsTurn[] }

type StatsRecord = {
  flow?: string
  agent?: string
  items?: Item[]
  rides?: Ride[]
}

// Exported for tests: one record's facts.
export function projectRecord(project: string, record: StatsRecord): Projection {
  const flow = taskFlow(record)
  let launchedAt: string | undefined
  const landedAt: string[] = []
  for (const item of record.items ?? []) {
    if (item.kind !== 'event') continue
    if (item.eventKind === 'launched') launchedAt ??= item.at
    else if (item.eventKind === 'landed') landedAt.push(item.at)
  }
  const turns: StatsTurn[] = (record.rides ?? []).map((ride) => ({
    project,
    flow: ride.flow ?? flow,
    startedAt: ride.startedAt,
    ...(ride.usage?.model ? { model: ride.usage.model } : {}),
    ...(ride.durationMs != null ? { durationMs: ride.durationMs } : {}),
    ...(ride.usage?.costUsd != null ? { costUsd: ride.usage.costUsd } : {}),
  }))
  return {
    task: { project, flow, ...(launchedAt ? { launchedAt } : {}), landedAt },
    turns,
  }
}

// One reader per project, since each projection carries its project's slug.
const readers = new Map<string, (dir: string) => Promise<Projected<Projection>[]>>()

function readerFor(slug: string) {
  let reader = readers.get(slug)
  if (!reader) {
    reader = retainedProjection((record) => projectRecord(slug, record as StatsRecord))
    readers.set(slug, reader)
  }
  return reader
}

export async function readStats(projects: Project[]): Promise<StatsFacts> {
  const projections: Projection[] = []
  for (const project of projects) {
    const read = readerFor(project.slug)
    for (const dir of [project.dataDir, project.archiveDir])
      for (const entry of await read(dir)) projections.push(entry.value)
  }
  return {
    recordedSince: RECORDED_SINCE,
    tasks: projections.map((p) => p.task),
    turns: projections.flatMap((p) => p.turns),
  }
}
