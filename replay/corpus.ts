// The labelled corpus, as cases a hook body can be run against.
//
// hooks.md §10 names three things that make replay harder than reading the task
// JSON, and each is answered here rather than in the body or the scorer:
//
//   1. **Truncation.** A task's items include everything after the event; replay
//      must cut at it, or the body sees its own future and every gate that looks
//      forward is vacuously right.
//   2. **Repository drift.** The tree as of a landing is recoverable only
//      approximately, and uncommitted state not at all — which is why nothing
//      here reconstructs one and `ctx.spawn` refuses (see replay.ts).
//   3. **Confounded labels.** "Was it reopened?" is not ground truth. The label
//      set says WHY each reopening happened, and the classes that are not a
//      defect are must-not-fire cases like any other landing.
//
// It reads the same `data/<normalized-project-path>/{tasks,archived}` layout the
// server owns, through the server's own `parseProjects`, rather than re-deriving
// it in a third place.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseProjects, projectSlug, type Project } from '../server/projects'
import { publicTask } from '../server/tasks'
import type { Item, Ride } from '../server/tasks'

// One reopening, classified by reading the first human message after it — the
// method hooks.md Appendix A used. Keyed by the landing it undid.
export type Labels = {
  shouldFire: string[]
  cases: {
    project: string
    task: string
    landedAt: string
    unlandedAt: string
    class: string
    note?: string
  }[]
}

export type ReplayCase = {
  project: string
  task: string
  title: string
  // The synthetic fire, as the dispatcher would have recorded it.
  trigger: { kind: string; by: string; at: string; rideId?: string; outcome?: string }
  // The class of the reopening that undid this landing, or 'clean'.
  label: string
  // Whether that class is one the candidate should have fired on.
  shouldFire: boolean
  // The provider the case's own task ran under, resolved the way the server
  // resolves it. Never `record.flow` alone: that field is optional, and the
  // pre-flow population carries only `agent`.
  flow: string
  // The record as it stood at the fire, through the same projection
  // `ctx.target.read()` serves.
  record: unknown
  // How many tool calls the span held, for the report's own caveats.
  tools: number
}

export type StoredTask = {
  id: string
  title?: string
  flow?: string
  agent?: string
  status?: string
  items?: Item[]
  rides?: Ride[]
  // Emptied by truncation: the historical queue is not recoverable, and
  // publicTask strips the field anyway — so what it costs is the `queued` flag
  // on trailing items, which is a no-op at length zero.
  queued?: string[]
  updatedAt?: string
  cwd?: string
  worktree?: boolean
}

const CROSSINGS = new Set(['landed', 'unlanded', 'wedged', 'unwedged'])

// The record as it stood at `items[eventIndex]`, inclusive.
//
// Four things move, and each was a way to get a wrong answer quietly:
//
//   - `items` is cut, so nothing after the fire is visible.
//   - a ride still open at the fire is RE-OPENED — its end, outcome and usage
//     stripped — so `openRide` answers what the live fire would have.
//   - the STORED status is replayed from the crossings up to the cut. It has to
//     be the stored one: publicTask re-derives the served value, and would
//     overwrite anything written as one.
//   - `queued` is emptied, because the historical queue is not recoverable.
//     publicTask strips the field itself, so what this costs is only the
//     `queued: true` flag on trailing items — which is a no-op at length zero,
//     and is the caveat the report prints.
export function truncateAt(task: StoredTask, eventIndex: number): StoredTask {
  const items = (task.items ?? []).slice(0, eventIndex + 1)
  const at = items[eventIndex]?.at ?? ''

  const rides = (task.rides ?? [])
    .filter((r) => r.startedAt <= at)
    .map((r) => {
      if (!r.endedAt || r.endedAt <= at) return r
      const { endedAt: _e, outcome: _o, usage: _u, ...open } = r
      return open as Ride
    })

  let status = 'riding'
  for (const it of items)
    if (it.kind === 'event' && CROSSINGS.has(it.eventKind))
      status = it.eventKind === 'landed' ? 'landed' : it.eventKind === 'wedged' ? 'wedged' : 'riding'

  return { ...task, items, rides, status, queued: [], updatedAt: at } as StoredTask
}

// Who caused a landing, inferred: `EventItem` carries no principal, which is
// also §8a's first arming precondition.
//
// A landing whose timestamp falls inside an open ride is read as the agent's.
// Validated against a second, positive-only signal (a `lander land` call in the
// preceding items): the two agree on 88% of the landings where either fired, and
// the residue bounds contamination of the `agent` class at ~7%. It is also WIDER
// than `by === 'agent'` — a sibling's `lander land <id>` lands a riding target
// too — so a gate priced on it is priced on an upper bound.
function landingPrincipal(task: StoredTask, at: string): string {
  return (task.rides ?? []).some(
    (r) => r.startedAt <= at && (!r.endedAt || r.endedAt >= at),
  )
    ? 'agent'
    : 'human'
}

// The project whose landings a hook in `root` would be dispatched for.
//
// Through the server's own `parseProjects`, so the `data/<normalized-project-
// path>/…` layout is not re-derived here — and defaulting to the slug of the
// checkout itself, which is what a hook committed to that repository is scoped
// to. `PROJECT_DIRS` is not set in an ordinary shell, so nothing else would
// resolve.
export function projectFor(slug?: string, root = process.cwd()): Project | undefined {
  const want = slug || projectSlug(root)
  return parseProjects(path.join(root, 'data'), process.env, root).find(
    (p) => p.slug === want,
  )
}

// Every landing in a project, as a case, newest first.
export async function loadCases(opts: {
  project: Project
  labels: Labels
  // Only the principal directory the hook lives under, since that is the
  // population it would actually be dispatched for.
  by?: string
}): Promise<ReplayCase[]> {
  const shouldFire = new Set(opts.labels.shouldFire)
  const byLanding = new Map<string, string>()
  for (const c of opts.labels.cases) {
    // The FIRST reopening of a landing is the one that undid it; a later one
    // belongs to a later landing.
    const key = `${c.task}\0${c.landedAt}`
    if (!byLanding.has(key)) byLanding.set(key, c.class)
  }

  const cases: ReplayCase[] = []
  for (const dir of [opts.project.dataDir, opts.project.archiveDir]) {
    let files: string[] = []
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
    } catch {
      continue
    }
    for (const f of files) {
      let task: StoredTask
      try {
        task = JSON.parse(await readFile(path.join(dir, f), 'utf8')) as StoredTask
      } catch {
        continue
      }
      const items = task.items ?? []
      items.forEach((it, i) => {
        if (it.kind !== 'event' || it.eventKind !== 'landed') return
        const by = landingPrincipal(task, it.at)
        if (opts.by && opts.by !== 'any' && by !== opts.by) return
        const label = byLanding.get(`${task.id}\0${it.at}`) ?? 'clean'
        // Tool calls in the span this landing closes — from the preceding human
        // message — which is what a completeness judge has to read.
        const isUser = (x: Item): boolean => x.kind === 'message' && x.role === 'user'
        let start = i
        while (start > 0 && !isUser(items[start - 1])) start--
        cases.push({
          project: opts.project.slug,
          task: task.id,
          title: task.title ?? '',
          trigger: { kind: 'landed', by, at: it.at },
          label,
          shouldFire: shouldFire.has(label),
          flow: task.flow ?? task.agent ?? 'claude',
          record: publicTask(truncateAt(task, i)),
          tools: items.slice(start, i).filter((x) => x.kind === 'tool').length,
        })
      })
    }
  }
  return cases.sort((a, b) => (a.trigger.at < b.trigger.at ? 1 : -1))
}
