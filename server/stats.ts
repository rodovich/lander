// The facts the stats dashboard graphs, projected from every task record in
// every configured project — active and archived alike. The server only
// projects; bucketing by day, week, or month happens in the browser, which is
// the one place that knows the viewer's time zone.
//
// A projection is kept per file, revalidated against its stat on every call the
// way readTaskEntries does, but it holds only the handful of fields a chart
// reads rather than the whole parse: the archive runs to hundreds of megabytes
// of conversations, and nothing else keeps it resident.

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Project } from './projects'
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
type Cached = { mtimeMs: number; size: number; projection: Projection }

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
    flow,
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

// Keyed by absolute path: archiving renames a file between the two pools while
// preserving its stat, so a basename key would collide by construction.
const retained = new Map<string, Cached>()

async function readPool(
  slug: string,
  dir: string,
  next: Map<string, Cached>,
  out: Projection[],
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        const file = path.join(dir, name)
        try {
          const s = await stat(file)
          const hit = retained.get(file)
          const projection =
            hit && hit.mtimeMs === s.mtimeMs && hit.size === s.size
              ? hit.projection
              : projectRecord(
                  slug,
                  JSON.parse(await readFile(file, 'utf8')) as StatsRecord,
                )
          next.set(file, { mtimeMs: s.mtimeMs, size: s.size, projection })
          out.push(projection)
        } catch {
          // Moved mid-scan, or unreadable: skipped, as the list skips it.
        }
      }),
  )
}

export async function readStats(projects: Project[]): Promise<StatsFacts> {
  const next = new Map<string, Cached>()
  const projections: Projection[] = []
  for (const project of projects) {
    await readPool(project.slug, project.dataDir, next, projections)
    await readPool(project.slug, project.archiveDir, next, projections)
  }
  // Rebuilt from this call's scan, so an entry for a removed file is not
  // carried forward.
  retained.clear()
  for (const [file, cached] of next) retained.set(file, cached)
  return {
    recordedSince: RECORDED_SINCE,
    tasks: projections.map((p) => p.task),
    turns: projections.flatMap((p) => p.turns),
  }
}
