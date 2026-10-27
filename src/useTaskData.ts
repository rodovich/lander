import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  loadShownTasks,
  loadTask,
  loadTaskLinks,
  type FlowTelemetry,
  type TaskSearchRequest,
  type TaskSearchResult,
} from './api'
import { useDebounced, useSessionState } from './hooks'
import type { TaskLinkResolver } from './markdown'
import { startPoll, type Poll } from './poll'
import { MonotonicRequestGate } from './requestOrder'
import { taskHref, taskKey, taskKeyOf, type TaskRef } from './taskRef'
import {
  admitTask as admitToFence,
  beginTaskPatch,
  createTaskMutationFence,
  insertTask,
  mergeTaskRefresh,
  patchTask,
  removeTask,
  replaceTask,
  settleTaskPatch,
  settleTaskRemoval,
  type TaskMutationHandle,
  type TaskPatch,
} from './taskMutationFence'
import type { FlowCaps, Project, TaskLink, TaskView, TaskWithProject } from './types'

// The gap between one poll's answer and the next poll's question. Measured
// from the answer (see startPoll), so this is the cadence at rest and the
// floor under load — never a schedule that keeps firing into a backlog.
const POLL_GAP_MS = 2000
// The project list changes only when someone edits the config, and a reload
// picks it up at once, so it is polled far less often.
const PROJECTS_POLL_GAP_MS = 30_000
// How long the search box must sit still before its query goes to the server.
const SEARCH_SETTLE_MS = 150

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

// The client's task data: the displayed task list and its polling, the open
// task's conversation, the server's search of the listed conversations, the
// installation-wide compact index used for link resolution, per-flow
// telemetry, and the project list with the session's open project. Of the view
// state it holds only what the requests carry: `project`, which task is open
// (as the caller reports it through watchTask), and how many of a task's
// matches the list asked for. The view/time filters and the search box stay
// with the caller, which passes in the box's query (trimmed and lowercased).
export function useTaskData(
  view: TaskView,
  onPollError: (message: string | null) => void,
  initialProjectSlug = '',
  query = '',
) {
  const [tasks, setTasks] = useState<TaskWithProject[]>([])
  // Active + archived links across every configured project, independent of
  // the displayed project filter and carrying no conversation data.
  const [taskLinks, setTaskLinks] = useState<TaskLink[]>([])
  const [taskLinksLoaded, setTaskLinksLoaded] = useState(false)
  // Per-flow status telemetry (agent → items), carried on every tasks poll. The
  // producing flow decides when to refresh; the client just renders the latest
  // snapshot it was handed for whichever flow is in view.
  const [telemetry, setTelemetry] = useState<FlowTelemetry>({})
  // Each flow's capabilities by name, carried on every tasks poll the same way.
  const [flowCaps, setFlowCaps] = useState<Record<string, FlowCaps>>({})
  const [projects, setProjects] = useState<Project[]>([])
  // The project the navbar has open, whose tasks the list shows. Session-scoped
  // so it survives a reload but stays per-tab; reconciled against the live
  // project list once it loads (see the /api/projects effect).
  const [project, setProject] = useSessionState('lander:project', '')

  // Latest tasks readable from timer callbacks that outlive the render that
  // scheduled them (the seen-marker dwell timer marks a task seen 2s later).
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  // Whether the first tasks load has landed, for effects that must hold off
  // until then (the URL sync, which would otherwise clobber a deep link).
  const hasLoadedRef = useRef(false)

  // Task writes are optimistic while the displayed-list poll runs
  // independently. Fence only the task being written: stale snapshots cannot
  // roll it back, while changes to every other task still land normally. The
  // fenced operations below (patch, removal, admit) and the poll's merge are
  // the only writers of `tasks`; setTasks stays private so no optimistic write
  // can skip the fence.
  const taskMutationFenceRef = useRef(createTaskMutationFence())
  const beginTaskMutation = useCallback(
    (task: TaskWithProject, patch: TaskPatch): TaskMutationHandle => {
      const handle = beginTaskPatch(taskMutationFenceRef.current, task, patch)
      setTasks((prev) => patchTask(prev, handle.key, patch))
      return handle
    },
    [],
  )
  const finishTaskMutation = useCallback(
    (handle: TaskMutationHandle, updated?: TaskWithProject) => {
      const replacement = settleTaskPatch(
        taskMutationFenceRef.current,
        handle,
        updated,
      )
      if (replacement)
        setTasks((prev) => replaceTask(prev, handle.key, replacement))
    },
    [],
  )
  // The same fence for a write that takes a task out of the displayed list (an
  // archive or restore): drop the row at once, keep polls that predate the
  // write from bringing it back, and reinstate it if the write fails.
  const beginTaskRemoval = useCallback(
    (task: TaskWithProject): TaskMutationHandle => {
      const handle = beginTaskPatch(taskMutationFenceRef.current, task, 'removed')
      setTasks((prev) => removeTask(prev, handle.key))
      return handle
    },
    [],
  )
  const finishTaskRemoval = useCallback(
    (handle: TaskMutationHandle, succeeded: boolean) => {
      const reinstated = settleTaskRemoval(
        taskMutationFenceRef.current,
        handle,
        succeeded,
      )
      if (reinstated) setTasks((prev) => insertTask(prev, reinstated))
    },
    [],
  )
  // Poll the project list, which changes when the server restarts onto an
  // edited config. Reconcile the open project against each new list: on the
  // first load the routed task's project wins, then the session-restored pick
  // if it still exists, then the first project.
  useEffect(() => {
    let routed = initialProjectSlug
    let last = ''
    const loadProjects = () =>
      fetch('/api/projects')
        .then((r) => r.json())
        .then((list: Project[]) => {
          const sig = JSON.stringify(list)
          if (sig === last) return
          last = sig
          setProjects(list)
          const all = list.map((p) => p.slug)
          const preferred = routed
          routed = ''
          setProject((prev) =>
            all.includes(preferred)
              ? preferred
              : all.includes(prev)
                ? prev
                : (all[0] ?? ''),
          )
        })
        .catch(() => {})
    return startPoll(loadProjects, PROJECTS_POLL_GAP_MS).stop
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const archived = view === 'archived'
  const refreshScope = `${project}\n${archived}`
  const refreshScopeRef = useRef(refreshScope)
  refreshScopeRef.current = refreshScope

  // Show a task the server just created from its own answer, ahead of any poll
  // — but only into a list that would carry it: a task created in a project
  // that isn't open, or while the archived pool is displayed, is one the next
  // poll would rightly omit, so admitting it would paint a row that vanishes
  // two seconds later. The fence boundary is set outside the state updater: an
  // updater may run twice under StrictMode, and the clock must advance exactly
  // once per admit.
  const admitTask = useCallback(
    (task: TaskWithProject) => {
      if (archived || task.projectSlug !== project) return
      admitToFence(taskMutationFenceRef.current, task)
      setTasks((prev) => insertTask(prev, task))
    },
    [project, archived],
  )

  // The task whose conversation is on screen. The list arrives as summaries,
  // so this one task is fetched whole alongside each list load.
  const [watched, setWatched] = useState<TaskRef | null>(null)
  const watchTask = useCallback((task: TaskWithProject | null) => {
    setWatched((prev) =>
      !task
        ? null
        : prev?.projectSlug === task.projectSlug && prev.id === task.id
          ? prev
          : { projectSlug: task.projectSlug, id: task.id },
    )
  }, [])

  // The search the list load runs, and what it last found. A task's match list
  // runs past the server's default only once the list asks for more of it
  // (requestMatches), and only for the query it asked under.
  const searchQuery = useDebounced(query, SEARCH_SETTLE_MS)
  const [matchLimits, setMatchLimits] = useState<{
    query: string
    byKey: Map<string, TaskSearchRequest['limits'][number]>
  }>({ query: '', byKey: new Map() })
  const searchRequest = useMemo<TaskSearchRequest | undefined>(
    () =>
      searchQuery
        ? {
            query: searchQuery,
            limits:
              matchLimits.query === searchQuery ? [...matchLimits.byKey.values()] : [],
          }
        : undefined,
    [searchQuery, matchLimits],
  )
  const requestMatches = useCallback(
    (task: TaskWithProject, limit: number) => {
      setMatchLimits((prev) => {
        const byKey = new Map(prev.query === searchQuery ? prev.byKey : [])
        byKey.set(taskKeyOf(task), {
          projectSlug: task.projectSlug,
          id: task.id,
          limit,
        })
        return { query: searchQuery, byKey }
      })
    },
    [searchQuery],
  )
  const [search, setSearch] = useState<TaskSearchResult | null>(null)

  // Load the shown tasks (and the telemetry snapshot and search results that
  // ride along), with the watched task whole in place of its summary, and
  // commit them. Shared by the 2s poll and the action paths that reconcile
  // after a mutation — so every part of the payload lands everywhere. The epoch
  // guard drops a stale in-flight load once the scope it was issued under (open
  // project, archived flag) has changed: the moral equivalent of the old poll
  // effect's `canceled` flag, extended to the action-path refreshes. A change
  // of search or watched task doesn't drop the poll's load in flight: that load
  // commits under the old values, and the next one starts as it settles, so the
  // two never overlap. Resolves with the open task's fetch failure, if any,
  // for the poll to report; the actions' `refresh` drops it, since thrown it
  // would make an action whose own write succeeded look like it had failed.
  const epochRef = useRef(0)
  const refreshOrderRef = useRef(new MonotonicRequestGate())
  const searchRequestRef = useRef(searchRequest)
  searchRequestRef.current = searchRequest
  const watchedRef = useRef(watched)
  watchedRef.current = watched
  const pollRef = useRef<Poll | null>(null)
  useEffect(() => {
    pollRef.current?.runNow()
  }, [searchRequest, watched])
  const load = useCallback(async (): Promise<unknown> => {
    const epoch = epochRef.current
    const requestOrder = refreshOrderRef.current
    const request = requestOrder.begin()
    const mutationFence = taskMutationFenceRef.current
    const issuedAt = mutationFence.clock
    const searchRequest = searchRequestRef.current
    const watched = watchedRef.current
    const watchedKey = watched && taskKey(watched.projectSlug, watched.id)
    try {
      const [{ tasks, telemetry, flows, search }, detail] = await Promise.all([
        loadShownTasks([project], archived, searchRequest),
        watched
          ? loadTask(watched.projectSlug, watched.id).then(
              (task) => ({ task }),
              (error: unknown) => ({ error }),
            )
          : null,
      ])
      if (
        refreshScope !== refreshScopeRef.current ||
        epoch !== epochRef.current ||
        !requestOrder.settle(request)
      )
        return null
      setTasks((current) => {
        // A failed detail keeps the conversation already on screen under the
        // fresh summary, rather than blanking the open task for a cycle.
        const prev = current.find((c) => taskKeyOf(c) === watchedKey)
        const shown = tasks.map((t) =>
          !detail || taskKeyOf(t) !== watchedKey
            ? t
            : 'task' in detail
              ? detail.task
              : { ...t, items: prev?.items, rides: prev?.rides },
        )
        return mergeTaskRefresh(mutationFence, issuedAt, current, shown)
      })
      setTelemetry(telemetry)
      setFlowCaps(flows)
      setSearch(search)
      hasLoadedRef.current = true
      return detail && 'error' in detail ? detail.error : null
    } catch (error) {
      // A stale failure must not paint an error over a newer successful poll.
      if (
        refreshScope !== refreshScopeRef.current ||
        epoch !== epochRef.current ||
        !requestOrder.settle(request)
      )
        return null
      throw error
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, archived])
  const refresh = useCallback(async () => {
    await load()
  }, [load])

  useEffect(() => {
    if (project === '') return
    // Poll so assistant replies appear once the server appends them.
    //
    // Each cycle reports its own outcome, failure *and* recovery. The banner
    // carries no timestamp, so it reads in the present tense — and a failed poll
    // that stayed up until some unrelated action happened to clear it went on
    // claiming something was wrong long after the next cycle had proved
    // otherwise. The common case is a one-cycle gap while `tsx watch` restarts
    // the API server, which self-heals in about two seconds. A failure that
    // isn't transient keeps being re-reported by every cycle that follows it, so
    // nothing here hides a server that is actually down.
    const poll = startPoll(
      () =>
        load().then(
          (detailError) => onPollError(detailError ? errorMessage(detailError) : null),
          (e) => onPollError(errorMessage(e)),
        ),
      POLL_GAP_MS,
    )
    pollRef.current = poll
    return () => {
      epochRef.current++
      refreshOrderRef.current.invalidate()
      pollRef.current = null
      poll.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  // Maintain the installation-wide compact projection for task references.
  // The ETag makes unchanged 2s polls bodyless, while polling at the displayed
  // list cadence keeps mention colors and archive routing current.
  useEffect(() => {
    let canceled = false
    let etag: string | undefined
    const requestOrder = new MonotonicRequestGate()
    const refreshLinks = async () => {
      const request = requestOrder.begin()
      try {
        const response = await loadTaskLinks(etag)
        if (canceled || !requestOrder.settle(request)) return
        if (response.etag) etag = response.etag
        if (!response.notModified) setTaskLinks(response.links)
        setTaskLinksLoaded(true)
      } catch {
        if (!canceled) requestOrder.settle(request)
        // Link resolution is presentational; keep the last good projection.
      }
    }
    const { stop } = startPoll(refreshLinks, POLL_GAP_MS)
    return () => {
      canceled = true
      requestOrder.invalidate()
      stop()
    }
  }, [])

  // A content-stable index for mention resolution. The feed gets a fresh array
  // only after a changed ETag, and each open message
  // calls the resolver once per id-shaped token (thousands, on a pasted log). So
  // we depend on a *signature* of only the fields resolution reads (id, slug,
  // title, status) rather than the array reference: `linkIndex` — and therefore
  // `resolveTaskLink`'s identity and the memoized messages that use it — changes
  // only when a mention could actually resolve differently, not on every poll.
  // The precomputed lowercased ids and link objects also keep each resolver call
  // cheap.
  const linkSig = taskLinks
    .map(
      (t) =>
        `${t.id}\t${t.projectSlug}\t${t.title}\t${t.status}\t${t.archived}`,
    )
    .join('\n')
  const linkIndex = useMemo(
    () =>
      taskLinks.map((t) => ({
        id: (t.id ?? '').toLowerCase(),
        rawId: t.id,
        projectSlug: t.projectSlug,
        link: {
          href: taskHref(t.projectSlug, t.id),
          title: t.title,
          status: t.status,
        },
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [linkSig],
  )

  // Resolve a bare task id found in a message to an internal link to that task,
  // used to turn such references into clickable links with the task's title as
  // the text. A uuid (>= 36 chars) is matched exactly; anything shorter matches
  // by prefix and links only when it uniquely identifies one global task.
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
    (id, projectSlug) => {
      // A legacy/garbled reference can hand us an empty id (e.g. an old
      // "awaiting" event saved under the pre-rename shape); resolve it to no link
      // rather than throwing and taking down the whole task view.
      if (!id) return undefined
      if (projectSlug) {
        const matches = linkIndex.filter(
          (e) => e.rawId === id && e.projectSlug === projectSlug,
        )
        return matches.length === 1 ? matches[0].link : undefined
      }
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
    tasksRef,
    telemetry,
    flowCaps,
    projects,
    project,
    setProject,
    refresh,
    watchTask,
    search,
    requestMatches,
    beginTaskMutation,
    finishTaskMutation,
    beginTaskRemoval,
    finishTaskRemoval,
    admitTask,
    hasLoadedRef,
    resolveTaskLink,
    taskLinks,
    taskLinksLoaded,
  }
}
