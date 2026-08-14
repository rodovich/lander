import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadShownTasks, type FlowTelemetry } from './api'
import { useSessionState } from './hooks'
import type { TaskLinkResolver } from './markdown'
import type { Project, TaskView, TaskWithProject } from './types'

// The client's task data: the displayed task list and its polling, the
// cross-view union used for link resolution, per-flow telemetry, and the
// project list with the session's project filter. Owns no view state beyond
// `shown` — the view/time/search filters stay with the caller.
export function useTaskData(view: TaskView, onError: (message: string) => void) {
  const [tasks, setTasks] = useState<TaskWithProject[]>([])
  // Active + archived tasks across shown projects, used only to resolve
  // task-id mentions to links. The displayed `tasks` list holds just the
  // current view's set (active OR archived — they come from separate
  // endpoints), so without this an archived id referenced from an inbox
  // message — or vice versa — wouldn't link.
  const [linkTasks, setLinkTasks] = useState<TaskWithProject[]>([])
  // Per-flow status telemetry (agent → items), carried on every tasks poll. The
  // producing flow decides when to refresh; the client just renders the latest
  // snapshot it was handed for whichever flow is in view.
  const [telemetry, setTelemetry] = useState<FlowTelemetry>({})
  const [projects, setProjects] = useState<Project[]>([])
  // The project dropdown acts as a filter: `shown` holds the slugs whose tasks
  // are merged into the list. It is always either a single project or every
  // project ("show all"); see showOnly/showAll in the project menu.
  // Session-scoped so it survives a reload but stays per-tab; reconciled
  // against the live project list once it loads (see the /api/projects effect).
  const [shown, setShown] = useSessionState<string[]>('lander:shown', [])

  // Latest tasks readable from timer callbacks that outlive the render that
  // scheduled them (the seen-marker dwell timer marks a task seen 2s later).
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  // Whether the first tasks load has landed, for effects that must hold off
  // until then (the URL sync, which would otherwise clobber a deep link).
  const hasLoadedRef = useRef(false)

  // Load the project list once. Reconcile the session-restored project filter
  // against it — keeping the picked slugs that still exist, and falling back to
  // "show all" only when nothing valid was restored (first visit, or every
  // picked project has since gone away).
  useEffect(() => {
    fetch('/api/projects')
      .then((r) => r.json())
      .then((list: Project[]) => {
        setProjects(list)
        const all = list.map((p) => p.slug)
        setShown((prev) => {
          const valid = prev.filter((s) => all.includes(s))
          return valid.length > 0 ? valid : all
        })
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const shownKey = shown.join(',')
  const archived = view === 'archived'

  // Load the shown tasks (and the telemetry snapshot that rides along) and
  // commit them. Shared by the 2s poll and the action paths that reconcile
  // after a mutation — so both halves of the payload land everywhere. The epoch
  // guard drops a stale in-flight load once the scope it was issued under
  // (shown set, archived flag) has changed: the moral equivalent of the old
  // poll effect's `cancelled` flag, extended to the action-path refreshes.
  const epochRef = useRef(0)
  const refresh = useCallback(async () => {
    const epoch = epochRef.current
    const { tasks, telemetry } = await loadShownTasks(shown, archived)
    if (epoch !== epochRef.current) return
    setTasks(tasks)
    setTelemetry(telemetry)
    hasLoadedRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey, archived])

  useEffect(() => {
    if (shownKey === '') return
    const tick = () =>
      refresh().catch((e) => onError(e.message ?? String(e)))
    tick()
    // Poll so assistant replies appear once the server appends them.
    const timer = setInterval(tick, 2000)
    return () => {
      epochRef.current++
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

  // Maintain the union of active and archived tasks for link resolution,
  // independent of the current view. Archived state changes rarely, so this
  // polls less often than the displayed list.
  //
  // Summaries: resolution reads id/projectSlug/title/status (see linkIndex
  // below) and nothing else, so this poll asks the server to leave the
  // conversation out — two requests per project against both pools, held in
  // state, is otherwise tens of megabytes every ten seconds. `items`/`rides`
  // are optional on `Task`, so a summary is still a `TaskWithProject`.
  useEffect(() => {
    if (shown.length === 0) return
    let cancelled = false
    const refreshLinks = () =>
      Promise.all([
        loadShownTasks(shown, false, { summary: true }),
        loadShownTasks(shown, true, { summary: true }),
      ])
        .then(([active, archived]) => {
          if (!cancelled) setLinkTasks([...active.tasks, ...archived.tasks])
        })
        .catch(() => {})
    refreshLinks()
    const timer = setInterval(refreshLinks, 10000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey])

  // A content-stable index for mention resolution. linkTasks gets a fresh array
  // every 10s poll even when nothing relevant changed, and each open message
  // calls the resolver once per id-shaped token (thousands, on a pasted log). So
  // we depend on a *signature* of only the fields resolution reads (id, slug,
  // title, status) rather than the array reference: `linkIndex` — and therefore
  // `resolveTaskLink`'s identity and the memoized messages that use it — changes
  // only when a mention could actually resolve differently, not on every poll.
  // The precomputed lowercased ids and link objects also keep each resolver call
  // cheap.
  const linkSig = linkTasks
    .map((t) => `${t.id}\t${t.projectSlug}\t${t.title}\t${t.status}`)
    .join('\n')
  const linkIndex = useMemo(
    () =>
      linkTasks.map((t) => ({
        id: (t.id ?? '').toLowerCase(),
        link: { href: `/${t.projectSlug}/${t.id}`, title: t.title, status: t.status },
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [linkSig],
  )

  // Resolve a bare task id found in a message to an internal link to that task,
  // used to turn such references into clickable links with the task's title as
  // the text. A uuid (>= 36 chars) is matched exactly; anything shorter matches
  // by prefix and links only when it uniquely identifies one loaded task.
  //
  // That prefix fallback is deliberately kept even though the CLI now requires
  // whole ids. Stored messages are immutable, and for months the task prompt
  // told agents to print "an unambiguous prefix" — so history is full of 8- and
  // 9-char abbreviations (and, from the uuid era, 8-char hex ones) that would
  // otherwise stop linking. It is safe here in a way it was not in the CLI:
  // resolution is presentational, an ambiguous prefix simply falls back to
  // plain text, and nothing is mutated on the strength of the guess.
  //
  // Returns undefined when nothing matches, so the id renders as plain text.
  // Keyed on linkIndex (see above) so it re-renders messages exactly when
  // resolution could change — including the first-load transition from an empty
  // list, without which ids would stay literal forever.
  const resolveTaskLink = useCallback<TaskLinkResolver>(
    (id) => {
      // A legacy/garbled reference can hand us an empty id (e.g. an old
      // "awaiting" event saved under the pre-rename shape); resolve it to no link
      // rather than throwing and taking down the whole task view.
      if (!id) return undefined
      const needle = id.toLowerCase()
      const matches =
        needle.length >= 36
          ? linkIndex.filter((e) => e.id === needle)
          : linkIndex.filter((e) => e.id.startsWith(needle))
      return matches.length === 1 ? matches[0].link : undefined
    },
    [linkIndex],
  )

  return {
    tasks,
    setTasks,
    tasksRef,
    telemetry,
    projects,
    shown,
    setShown,
    refresh,
    hasLoadedRef,
    resolveTaskLink,
  }
}
