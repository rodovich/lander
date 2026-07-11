import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  loadShownTasks,
  uiHeaders,
  uploadAttachments,
  type FlowTelemetry,
} from './api'
import { AskForm } from './asks'
import { AttachButton, MessageArtifacts, MessageAttachments } from './attachments'
import { dataTransferHasFiles } from './fileDrop'
import {
  DATE_CATEGORY_LABELS,
  dateCategory,
  formatTaskTime,
  formatTimestamp,
  lastPathComponent,
  taskIdFromPath,
  worktreeName,
} from './format'
import { BlockedSummary, GrantControl } from './grants'
import { useFileDrop, usePersistentState, useSessionState } from './hooks'
import type { TaskLinkResolver } from './markdown'
import {
  CopyIdButton,
  ReadOnlyMenu,
  SectionActionsMenu,
  TaskActionsMenu,
} from './menus'
import { MessageText } from './messageText'
import { tick, timed } from './perf'
import { blockedRequests } from './permissions'
import { ResizeHandle } from './resizeHandle'
import { StatusTransition } from './statusTransition'
import {
  isUnread,
  latestUpdateAt,
  latestUsage,
  taskAgentModelName,
  taskUsageTelemetry,
  totalUsage,
} from './taskMeta'
import { buildTimeline } from './timeline'
import type { TimelineEntry } from './timeline'
import { Collapsible, ToolStep } from './toolStep'
import { planTurnCollapse } from './turnCollapse'
import { TelemetryItemView, TelemetryPanel } from './telemetry'
import type {
  AskItem,
  DateCategory,
  Project,
  Ride,
  Task,
  TaskView,
  TaskWithProject,
  TimeFilter,
} from './types'

// The task's currently-open ride (the last one without an `endedAt`), if any —
// the in-flight turn. Mirrors the server's openRide; drives the trailing spinner
// and the stream-pinning signal.
function openRide(task: { rides?: Ride[] } | null | undefined): Ride | undefined {
  const rides = task?.rides
  if (!rides) return undefined
  for (let i = rides.length - 1; i >= 0; i--)
    if (!rides[i].endedAt) return rides[i]
  return undefined
}

export function App() {
  // Opt-in profiling (see perf.ts): count every App render. The whole
  // conversation re-renders on each one — the 2s poll, streaming updates, and
  // every scroll/tab-focus state change all trip it — so a high count against a
  // little interaction is itself a finding.
  tick('App.render')
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
  // project ("show all"); see showOnly/showAll below. Session-scoped so it
  // survives a reload but stays per-tab; reconciled against the live project
  // list once it loads (see the /api/projects effect).
  const [shown, setShown] = useSessionState<string[]>('lander:shown', [])
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // The list's task-slice filter (see TaskView), session-scoped so it survives
  // a reload but can differ per tab.
  const [view, setView] = useSessionState<TaskView>('lander:view', 'inbox')
  // The list's time-window filter (see TimeFilter), session-scoped alongside view.
  const [timeFilter, setTimeFilter] = useSessionState<TimeFilter>(
    'lander:timeFilter',
    'any',
  )
  // The user's explicit task pick. The effective selection (`selected`, below)
  // falls back to the first visible task when this one is filtered away.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    () => taskIdFromPath() || null,
  )
  const [error, setError] = useState<string | null>(null)
  // The list search box, session-scoped alongside the other list filters.
  const [filter, setFilter] = useSessionState('lander:filter', '')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // The new-task form's draft fields persist across reloads so a half-composed
  // task — its message and its agent/project choices — isn't lost to a hot
  // reload or refresh. Session-scoped: two tabs composing different tasks keep
  // independent drafts (localStorage would let them clobber each other, and
  // since these fields drive the submission, a shared newProject could even
  // send a task to the wrong project).
  const [message, setMessage] = useSessionState('lander:draft:newTask', '')
  const [newTaskAgent, setNewTaskAgent] = useSessionState<Task['agent']>(
    'lander:draft:newAgent',
    'claude',
  )
  // Explicit project override for the new-task form; empty means "follow the
  // default" (targetSlug below).
  const [newProject, setNewProject] = useSessionState(
    'lander:draft:newProject',
    '',
  )
  // Whether the corner usage readout sums across the whole task or shows just
  // the latest turn. Clicking it toggles; persisted so the choice sticks.
  const [usageTotal, setUsageTotal] = usePersistentState(
    'lander:usageTotal',
    false,
  )
  // Heights of the two resizable bottom panels, dragged via the handle above
  // each and persisted globally so the sizing sticks across tabs and reloads.
  // The scrollable region above each (the message timeline, the task list)
  // absorbs the difference.
  const [composerHeight, setComposerHeight] = usePersistentState(
    'lander:size:composer',
    150,
  )
  const [newTaskHeight, setNewTaskHeight] = usePersistentState(
    'lander:size:newTask',
    220,
  )
  const [submitting, setSubmitting] = useState(false)

  // Each task keeps its own draft and in-flight state, keyed by id, so you
  // can start a reply in one task, switch away, and come back to finish it; the
  // drafts persist across reloads alongside the new-task message and, like it,
  // are session-scoped so two tabs don't clobber each other's reply drafts.
  const [replies, setReplies] = useSessionState<Record<string, string>>(
    'lander:draft:replies',
    {},
  )
  const [sendingBy, setSendingBy] = useState<Record<string, boolean>>({})
  const [answeringBy, setAnsweringBy] = useState<Record<string, boolean>>({})
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // Files attached to the new-task message and to per-task replies, held as File
  // objects (not session-persisted — File isn't serializable) and uploaded to the
  // durable store on submit. The paperclip <AttachButton> below each composer owns
  // its own hidden file input.
  const [newFiles, setNewFiles] = useState<File[]>([])
  const [replyFiles, setReplyFiles] = useState<Record<string, File[]>>({})

  // A browser treats an unhandled file drop as navigation to that local file.
  // Cancel that default at the window capture phase as a safety net: the target
  // composer's React handler still receives the event and attaches the files,
  // while a miss or a disabled composer simply leaves the current page intact.
  useEffect(() => {
    const preventFileNavigation = (e: DragEvent) => {
      if (e.dataTransfer && dataTransferHasFiles(e.dataTransfer))
        e.preventDefault()
    }
    window.addEventListener('dragover', preventFileNavigation, true)
    window.addEventListener('drop', preventFileNavigation, true)
    return () => {
      window.removeEventListener('dragover', preventFileNavigation, true)
      window.removeEventListener('drop', preventFileNavigation, true)
    }
  }, [])

  // The set of tool chips whose detail (a diff or captured output) is revealed,
  // keyed by the tool item's stable id. Details start closed and several can be
  // open at once (option/shift-click toggles a whole ride's worth).
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set())

  // Toggle one chip's detail, or — when option/shift was held — every detail in
  // its ride together, driving them all to this chip's new (opposite) state.
  function toggleDetail(key: string, messageKeys: string[]) {
    setOpenDetails((prev) => {
      const next = new Set(prev)
      const willOpen = !prev.has(key)
      for (const k of messageKeys) {
        if (willOpen) next.add(k)
        else next.delete(k)
      }
      return next
    })
  }

  // Assistant turns (other than the most recent) collapse their middle stretch of
  // items behind a disclosure; this holds the ride ids the viewer has expanded.
  // It's cleared on task switch, so each task opens with its history folded down
  // again.
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set())

  function toggleTurn(rideId: string) {
    setExpandedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(rideId)) next.delete(rideId)
      else next.add(rideId)
      return next
    })
  }

  // The two ambient conditions (alongside having a task open) that make the
  // viewer "actively viewing" it: the conversation is scrolled to its bottom,
  // and this browser tab is the active, focused one.
  const [atBottom, setAtBottom] = useState(true)
  const [tabActive, setTabActive] = useState(
    () => !document.hidden && document.hasFocus(),
  )

  // Whether DOM focus currently rests on a row inside the task list. While it
  // does, the Unread view holds onto tasks the viewer reads in place (see the
  // sticky-unread set below) so the list doesn't reshuffle under the keyboard;
  // moving focus to a text field or another window drops that hold.
  const [listFocused, setListFocused] = useState(false)
  // Tasks to keep in the Unread view even though they've been read, because
  // they were read while the list held focus. Accrues every unread task seen
  // during a focused spell and clears when focus leaves the list, at which point
  // the plain unread filter reapplies. Newly-unread tasks need no entry here —
  // they pass the filter on their own — but joining the set keeps them visible
  // if the viewer then reads them without leaving the list.
  const [stickyUnread, setStickyUnread] = useState<Set<string>>(new Set())

  // Latest tasks readable from timer callbacks that outlive the render that
  // scheduled them (the dwell timer below marks a task seen 2s later).
  const tasksRef = useRef(tasks)
  tasksRef.current = tasks

  // Track whether this tab is the active one: visible and window-focused.
  useEffect(() => {
    const update = () => setTabActive(!document.hidden && document.hasFocus())
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])

  // Maintain the sticky-unread set. Outside the focused Unread view it stays
  // empty (so the filter is the plain one). While the list holds focus on the
  // Unread view, fold every currently-unread task into it — including ones
  // that just arrived — so that reading a task (which clears its unread mark)
  // leaves it in the list rather than yanking it out from under the cursor.
  useEffect(() => {
    if (view !== 'unread' || !listFocused) {
      setStickyUnread((prev) => (prev.size ? new Set() : prev))
      return
    }
    setStickyUnread((prev) => {
      let next = prev
      for (const t of tasks) {
        if (isUnread(t) && !prev.has(t.id)) {
          if (next === prev) next = new Set(prev)
          next.add(t.id)
        }
      }
      return next
    })
  }, [view, listFocused, tasks])

  // Mark a task caught-up: advance its server-side `seenAt` to its latest
  // completed update, which clears its unseen dot. Optimistically advances the
  // local copy so the dot clears at once; the 2s poll reconciles. The server
  // stores the marker monotonically, so a stale/older value never moves it back.
  // Reads tasksRef so a delayed (dwell-timer) call sees the freshest data.
  async function markSeen(id: string) {
    const task = tasksRef.current.find((t) => t.id === id)
    if (!task) return
    const at = latestUpdateAt(task)
    if (!at || (task.seenAt && task.seenAt >= at)) return
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, seenAt: at } : t)),
    )
    try {
      await fetch(`/api/${task.projectSlug}/tasks/${id}/seen`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ at }),
      })
    } catch {
      // best-effort; a later dwell or the poll will retry the mark
    }
  }

  // Mark a task unread: reset its server-side `seenAt` so the task's latest
  // update reads as unviewed again, re-showing its dot. Optimistically clears
  // the local marker so the dot appears at once; the 2s poll reconciles. The
  // next time the viewer reads the task, markSeen advances the marker forward
  // again.
  async function markUnread(id: string) {
    const task = tasksRef.current.find((t) => t.id === id)
    if (!task) return
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, seenAt: '' } : t)),
    )
    try {
      await fetch(`/api/${task.projectSlug}/tasks/${id}/unread`, {
        method: 'POST',
      })
    } catch {
      // best-effort; the next poll restores the true marker
    }
  }

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [retitling, setRetitling] = useState<string | null>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)

  const pathBySlug = new Map(projects.map((p) => [p.slug, p.path]))
  const allShown = projects.length > 0 && shown.length === projects.length
  // Tag each task row with its project's leaf only when more than one project's
  // tasks can be intermixed; with a single project shown it's just noise.
  const showProjectLabels = shown.length > 1

  // The update-time bound the time filter imposes, in ms (local time), or null
  // for 'any'. 'today'/'week' keep tasks at or after the start of today / this
  // week (Sunday); 'older' keeps tasks strictly before the start of this week.
  // Recomputed each render so it tracks the wall clock.
  const timeCutoff = (() => {
    if (timeFilter === 'any') return null
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    if (timeFilter === 'week' || timeFilter === 'older')
      start.setDate(now.getDate() - now.getDay())
    return { ms: start.getTime(), before: timeFilter === 'older' }
  })()

  // Filter by time window, then by title (case-insensitive), before grouping.
  const query = filter.trim().toLowerCase()
  const matchedTasks = tasks.filter((t) => {
    if (timeCutoff != null) {
      const ts = Date.parse(t.updatedAt ?? t.createdAt)
      if (!Number.isNaN(ts)) {
        if (timeCutoff.before ? ts >= timeCutoff.ms : ts < timeCutoff.ms)
          return false
      }
    }
    if (view === 'unread' && !isUnread(t) && !stickyUnread.has(t.id))
      return false
    return query ? t.title.toLowerCase().includes(query) : true
  })

  // Group tasks by status — wedged (needs the user) first, then riding,
  // resting, and landed last — preserving each group's recency order within it
  // (matchedTasks is already sorted by updatedAt, and sort is stable). Unknown
  // statuses sort just ahead of landed.
  const STATUS_RANK: Record<string, number> = {
    wedged: 0,
    riding: 1,
    resting: 2,
    landed: 4,
  }
  const orderedTasks = [...matchedTasks].sort(
    (a, b) => (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3),
  )

  // Flatten orderedTasks into a list of rows interleaved with sticky headers:
  // a status header at every status change and, within a status whose tasks
  // span more than one date bucket, a date subheader at every bucket change.
  // Each task row keeps its orderedTasks index so the roving-tabindex refs and
  // keyboard navigation stay aligned with that array.
  const dayNow = new Date()
  const todayStart = new Date(
    dayNow.getFullYear(),
    dayNow.getMonth(),
    dayNow.getDate(),
  ).getTime()
  const weekStart = (() => {
    const s = new Date(todayStart)
    s.setDate(s.getDate() - s.getDay())
    return s.getTime()
  })()

  const dateCatsByStatus = new Map<string, Set<DateCategory>>()
  // Tasks per status+date bucket, keyed `${status}|${category}`, for the count a
  // date subheader's archive menu shows (and archives).
  const countByStatusDate = new Map<string, number>()
  for (const t of orderedTasks) {
    const cat = dateCategory(t.updatedAt ?? t.createdAt, todayStart, weekStart)
    const set = dateCatsByStatus.get(t.status) ?? new Set<DateCategory>()
    set.add(cat)
    dateCatsByStatus.set(t.status, set)
    const k = `${t.status}|${cat}`
    countByStatusDate.set(k, (countByStatusDate.get(k) ?? 0) + 1)
  }

  type TaskRow =
    | { kind: 'status'; key: string; status: string; first: boolean }
    | {
        kind: 'date'
        key: string
        category: DateCategory
        status: string
        first: boolean
      }
    | { kind: 'task'; key: string; task: TaskWithProject; index: number }

  const taskRows: TaskRow[] = []
  let rowStatus: string | null = null
  let rowCategory: DateCategory | null = null
  orderedTasks.forEach((task, index) => {
    if (task.status !== rowStatus) {
      taskRows.push({
        kind: 'status',
        key: `status-${task.status}`,
        status: task.status,
        // The first section gets no leading gap (nothing precedes it).
        first: rowStatus === null,
      })
      rowStatus = task.status
      rowCategory = null
    }
    const category = dateCategory(
      task.updatedAt ?? task.createdAt,
      todayStart,
      weekStart,
    )
    if (
      (dateCatsByStatus.get(task.status)?.size ?? 0) > 1 &&
      category !== rowCategory
    ) {
      taskRows.push({
        kind: 'date',
        key: `date-${task.status}-${category}`,
        category,
        status: task.status,
        // The first date in a status sits directly under the status header
        // (rowCategory is reset to null at each status change).
        first: rowCategory === null,
      })
      rowCategory = category
    }
    taskRows.push({ kind: 'task', key: task.id, task, index })
  })

  // Per-status counts for the summary row below the filter dropdown, ordered
  // left-to-right as the reverse of the list (landed, resting, riding, wedged
  // — STATUS_RANK descending). Only statuses present after filtering appear.
  const statusCounts = (() => {
    const counts = new Map<string, number>()
    for (const t of matchedTasks) {
      counts.set(t.status, (counts.get(t.status) ?? 0) + 1)
    }
    return [...counts.entries()].sort(
      (a, b) => (STATUS_RANK[b[0]] ?? 3) - (STATUS_RANK[a[0]] ?? 3),
    )
  })()
  const countByStatus = new Map(statusCounts)

  // The effective selection: the user's pick if it's still visible, otherwise
  // the first task in the list (e.g. after filtering hides the prior pick).
  const selected =
    selectedTaskId && tasks.some((t) => t.id === selectedTaskId)
      ? selectedTaskId
      : orderedTasks[0]?.id ?? null
  const current = tasks.find((t) => t.id === selected) ?? null

  // Each whole composer panel is one drop target, including its textarea,
  // paperclip, and surrounding action area. Keep the reply target bound to the
  // task currently open so switching tasks cannot leak a dropped file into
  // another task's draft.
  const newMessageDrop = useFileDrop<HTMLFormElement>(
    (picked) => setNewFiles((prev) => [...prev, ...picked]),
    submitting,
  )
  const replyDrop = useFileDrop<HTMLDivElement>(
    (picked) => {
      if (!current) return
      const id = current.id
      setReplyFiles((prev) => ({
        ...prev,
        [id]: [...(prev[id] ?? []), ...picked],
      }))
    },
    !current || !!current.archived || (sendingBy[current.id] ?? false),
  )

  // The open task's latest completed update, and whether the viewer is actively
  // viewing it (open + tab active + scrolled to the bottom where new content
  // lands). These drive the seen-marker advancement effect further below.
  const currentLatest = current ? latestUpdateAt(current) : ''
  const activelyViewing = !!current && tabActive && atBottom

  // The open task's conversation as a single stream: user bubbles, ride turns,
  // and lifecycle events in order. The ordering rules (ride grouping, queued
  // sinking, in-flight anchoring) all live in buildTimeline; `now` anchors any
  // in-flight turn. Queued follow-ups carry their own `queued` flag on the item.
  const { items: timeline } = current
    ? timed(
        'buildTimeline',
        () => buildTimeline(current, new Date().toISOString()),
        `${current.items?.length ?? 0} items`,
      )
    : { items: [] as TimelineEntry[] }

  // The task's open ask renders as the footer of the message item that raised it
  // (the message is the question, the form is the answer). There's at most one
  // open ask. `askAnchorId` is its `parentId` — the flow message item to hang it
  // under; when absent (a platform ask, or converted history with no anchor) the
  // form renders standalone below the conversation (see the fallback near the
  // composer).
  const openAsk = current?.items?.find(
    (it): it is AskItem => it.kind === 'ask' && it.state === 'open',
  )
  const askAnchorId = openAsk?.parentId

  // Whether the in-flight ride has already produced any item. When it has, the
  // ride block renders its own trailing "working…" spinner; when it hasn't (the
  // run was just handed off), the standalone "starting…" row stands in.
  const openR = openRide(current)
  const openRideHasItems =
    !!openR && (current?.items?.some((it) => it.rideId === openR.id) ?? false)

  // Roving-tabindex bookkeeping for the task list: the selected row is the one
  // reachable with Tab, and arrow keys move DOM focus between rows.
  const taskItemRefs = useRef<(HTMLLIElement | null)[]>([])
  const taskListRef = useRef<HTMLUListElement>(null)
  // A zero-height, non-sticky anchor sits just before each status header, keyed
  // by status, so the count chips can scroll its section to the top. We can't
  // measure the header itself: the headers all share top:0, so a header you've
  // scrolled past stays pinned at the top and reports its pinned position, not
  // where its section begins. The static anchor always reports its true layout
  // position, so the rect delta to the list top is correct scrolling either way.
  const sectionAnchorRefs = useRef<Map<string, HTMLLIElement>>(new Map())
  function scrollToStatus(status: string) {
    const anchor = sectionAnchorRefs.current.get(status)
    const list = taskListRef.current
    if (!anchor || !list) return
    const delta =
      anchor.getBoundingClientRect().top - list.getBoundingClientRect().top
    list.scrollTo({ top: list.scrollTop + delta, behavior: 'smooth' })
  }
  const selectedIndex = orderedTasks.findIndex((t) => t.id === selected)
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : 0

  function selectTask(id: string, projectSlug: string) {
    setSelectedTaskId(id)
    window.history.pushState(null, '', `/${projectSlug}/${id}`)
  }

  function focusTaskAt(index: number) {
    const clamped = Math.max(0, Math.min(orderedTasks.length - 1, index))
    taskItemRefs.current[clamped]?.focus()
  }

  function onTaskKeyDown(
    e: React.KeyboardEvent<HTMLLIElement>,
    index: number,
    task: TaskWithProject,
  ) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusTaskAt(index + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        focusTaskAt(index - 1)
        break
      case 'Home':
        e.preventDefault()
        focusTaskAt(0)
        break
      case 'End':
        e.preventDefault()
        focusTaskAt(orderedTasks.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        selectTask(task.id, task.projectSlug)
        break
    }
  }

  // Clicking a project shows only that project — unless it was already the only
  // one shown, in which case it expands back to all projects.
  function showOnly(slug: string) {
    if (shown.length === 1 && shown[0] === slug) {
      setShown(projects.map((p) => p.slug))
    } else {
      setShown([slug])
      // Picking a specific project also targets new tasks at it. Showing all
      // projects or changing the time/status filter leaves this untouched.
      setNewProject(slug)
    }
    setMenuOpen(false)
  }

  function showAll() {
    setShown(projects.map((p) => p.slug))
    setMenuOpen(false)
  }

  // Load the project list once. Reconcile the session-restored project filter
  // against it — keeping the picked slugs that still exist, and falling back to
  // "show all" only when nothing valid was restored (first visit, or every
  // picked project has since gone away). (A task named in the URL is seeded as
  // the selection by selectedTaskId's initializer.)
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
  }, [])

  // Keep the selection in sync when navigating with the browser back/forward
  // buttons.
  useEffect(() => {
    const onPop = () => setSelectedTaskId(taskIdFromPath() || null)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Mirror the effective selection into the URL as /<project>/<id>. Held
  // off until tasks have loaded so a deep-linked task isn't clobbered before
  // its project's tasks arrive. replaceState (not push) corrects the URL in
  // place without adding spurious history entries.
  const hasLoadedRef = useRef(false)
  useEffect(() => {
    if (!hasLoadedRef.current) return
    const cur = tasks.find((t) => t.id === selected)
    const desired = cur ? `/${cur.projectSlug}/${cur.id}` : '/'
    if (window.location.pathname !== desired) {
      window.history.replaceState(null, '', desired)
    }
  }, [selected, tasks])

  // Cmd/Ctrl+Shift+F focuses the task search field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        const el = searchInputRef.current
        el?.focus()
        el?.select()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Close the project menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const shownKey = shown.join(',')
  useEffect(() => {
    if (shown.length === 0) return
    let cancelled = false
    const refresh = () =>
      loadShownTasks(shown, view === 'archived')
        .then(({ tasks, telemetry }) => {
          if (!cancelled) {
            setTasks(tasks)
            setTelemetry(telemetry)
            hasLoadedRef.current = true
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e.message ?? String(e))
        })
    refresh()
    // Poll so assistant replies appear once the server appends them.
    const timer = setInterval(refresh, 2000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey, view])

  // Maintain the union of active and archived tasks for link resolution,
  // independent of the current view. Archived state changes rarely, so this
  // polls less often than the displayed list.
  useEffect(() => {
    if (shown.length === 0) return
    let cancelled = false
    const refresh = () =>
      Promise.all([loadShownTasks(shown, false), loadShownTasks(shown, true)])
        .then(([active, archived]) => {
          if (!cancelled) setLinkTasks([...active.tasks, ...archived.tasks])
        })
        .catch(() => {})
    refresh()
    const timer = setInterval(refresh, 10000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownKey])

  // The project a new task is created in: an explicit pick from the form's
  // dropdown if made, else the single shown project, else the project of the
  // task currently open, else the first project.
  const defaultTargetSlug =
    shown.length === 1
      ? shown[0]
      : current?.projectSlug ?? projects[0]?.slug ?? ''
  const targetSlug =
    newProject && projects.some((p) => p.slug === newProject)
      ? newProject
      : defaultTargetSlug

  // Resolve a bare task id or an unambiguous prefix found in a message to an
  // internal link to that task, used to turn such references into clickable
  // links with the task's title as the text. A full-length id (>= 36 chars) is
  // matched exactly; anything shorter matches by prefix, and links only when it
  // uniquely identifies one loaded task (mirroring the CLI's unambiguous-prefix
  // rule). Returns undefined otherwise so the id renders as plain text. This is
  // purely presentational — the stored message and what's sent to the model are
  // untouched.
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

  // Resolve a bare task id or an unambiguous prefix found in a message to an
  // internal link to that task, used to turn such references into clickable
  // links with the task's title as the text. A full-length id (>= 36 chars) is
  // matched exactly; anything shorter matches by prefix, and links only when it
  // uniquely identifies one loaded task (mirroring the CLI's unambiguous-prefix
  // rule). Returns undefined otherwise so the id renders as plain text. This is
  // purely presentational — the stored message and what's sent to the model are
  // untouched. Keyed on linkIndex (see above) so it re-renders messages exactly
  // when resolution could change — including the first-load transition from an
  // empty list, without which ids would stay literal forever.
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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    void createTask()
  }

  function onMessageKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Plain Enter creates the task; Shift+Enter / Option(Alt)+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      void createTask()
    }
  }

  async function createTask() {
    if (!message.trim() || submitting || !targetSlug) return
    setSubmitting(true)
    setError(null)
    try {
      const attachments = await uploadAttachments(targetSlug, newFiles)
      const r = await fetch(`/api/${targetSlug}/tasks`, {
        method: 'POST',
        headers: uiHeaders(),
        body: JSON.stringify({
          message,
          agent: newTaskAgent,
          // Human-launched tasks always get edit access; git and other Bash
          // are governed by the project's .claude permissions (Claude) or the
          // workspace-write sandbox (Codex). A read-only task is only ever
          // produced by a spawner declining to forward edits, and the human
          // can grant edits from the task header.
          allowEdits: true,
          ...(attachments.length ? { attachments } : {}),
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      const created = body as Task
      setTasks((await loadShownTasks(shown, view === 'archived')).tasks)
      selectTask(created.id, targetSlug)
      setMessage('')
      setNewFiles([])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  // Reset per-task view state when switching tasks so none of it bleeds across
  // them: leave title-edit mode and collapse revealed tool details and expanded
  // turns.
  useEffect(() => {
    setEditingTitle(false)
    setOpenDetails(new Set())
    setExpandedTurns(new Set())
  }, [selected])

  // Focus and select the title when entering edit mode.
  useEffect(() => {
    if (editingTitle) {
      const el = titleInputRef.current
      el?.focus()
      el?.select()
    }
  }, [editingTitle])

  function startTitleEdit() {
    if (!current) return
    setTitleDraft(current.title)
    setEditingTitle(true)
  }

  async function saveTitle() {
    if (!current) return
    const id = current.id
    const proj = current.projectSlug
    const next = titleDraft.trim()
    setEditingTitle(false)
    if (!next || next === current.title) return
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, title: next } : t)),
    )
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: next }),
      })
      if (!r.ok) {
        const body = await r.json()
        throw new Error(body.error ?? r.statusText)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Ask haiku (server-side) to name the task from its conversation.
  async function generateTitle() {
    if (!current || retitling === current.id) return
    const id = current.id
    const proj = current.projectSlug
    setRetitling(id)
    setError(null)
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}/retitle`, {
        method: 'POST',
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      const updated = body as Task
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, title: updated.title } : t)),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRetitling((prev) => (prev === id ? null : prev))
    }
  }

  function onTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      void saveTitle()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditingTitle(false)
    }
  }

  // Keep the conversation pinned to the latest content. We always jump to the
  // bottom when switching tasks, but when new content streams in we only follow
  // along if the reader was already at the bottom — otherwise scrolling up to
  // read earlier messages would be yanked back down on every poll.
  const messagesRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const prevSelectedRef = useRef<string | null>(null)

  function onMessagesScroll() {
    // Fires on every scroll frame; setAtBottom below re-renders the whole App
    // (and thus re-parses/re-renders every message's markdown) each time the
    // at-bottom boolean flips. Counted so the profile shows scroll-driven render
    // churn separately from poll/stream churn.
    tick('scroll.event')
    const el = messagesRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
    atBottomRef.current = bottom
    setAtBottom(bottom)
  }

  // Changes whenever the open task's in-flight ride grows — a new item, or the
  // last item's text/output filling in — so the effect re-pins as an assistant
  // turn streams. The open-ride flag tracks the trailing working-spinner row,
  // which adds and removes a row (changing the timeline's height) without any
  // item text changing, so the effect must re-pin for that too.
  const itemCount = current?.items?.length ?? 0
  const streamLen =
    current?.items?.reduce(
      (n, it) =>
        n +
        (it.kind === 'message'
          ? it.text.length
          : it.kind === 'tool'
            ? it.input.length + (it.output?.length ?? 0)
            : 0),
      0,
    ) ?? 0
  const streamSignal = `${itemCount}:${streamLen}:${current?.status}:${
    openRide(current) ? 1 : 0
  }`

  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    const switched = prevSelectedRef.current !== selected
    prevSelectedRef.current = selected
    if (switched) atBottomRef.current = true
    if (switched || atBottomRef.current) {
      el.scrollTop = el.scrollHeight
      // Pinning leaves us at the bottom; mirror that into the state the
      // active-viewing logic reads (a no-op when already true).
      setAtBottom(true)
    }
  }, [selected, current?.items?.length, streamSignal])

  // Move the open task's seen marker per the viewing rules. When the viewer
  // starts actively viewing a task (switches to it, focuses the tab, or scrolls
  // to the bottom), treat whatever's already there as a baseline and arm a 2s
  // dwell that marks it seen — so a glance that doesn't last doesn't clear the
  // dot. An update that arrives *while* actively viewing is past that baseline,
  // so it's marked seen at once.
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewTaskIdRef = useRef<string | null>(null)
  const viewBaselineRef = useRef<string>('')
  useEffect(() => {
    if (!activelyViewing || !current) {
      if (dwellTimerRef.current) {
        clearTimeout(dwellTimerRef.current)
        dwellTimerRef.current = null
      }
      viewTaskIdRef.current = null
      return
    }
    const id = current.id
    if (viewTaskIdRef.current !== id) {
      // Just began actively viewing this task: snapshot the baseline and arm the
      // dwell. Anything already present clears only once the 2s elapses.
      viewTaskIdRef.current = id
      viewBaselineRef.current = currentLatest
      if (dwellTimerRef.current) clearTimeout(dwellTimerRef.current)
      dwellTimerRef.current = setTimeout(() => {
        dwellTimerRef.current = null
        void markSeen(id)
      }, 2000)
    } else if (currentLatest > viewBaselineRef.current) {
      // A new update landed while actively viewing — seen immediately.
      viewBaselineRef.current = currentLatest
      void markSeen(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activelyViewing, currentLatest, current?.id])

  async function sendReply() {
    if (!current) return
    const id = current.id
    const proj = current.projectSlug
    const draft = replies[id] ?? ''
    if (!draft.trim() || sendingBy[id]) return
    setSendingBy((prev) => ({ ...prev, [id]: true }))
    setError(null)
    try {
      const attachments = await uploadAttachments(proj, replyFiles[id] ?? [])
      const r = await fetch(`/api/${proj}/tasks/${id}/messages`, {
        method: 'POST',
        headers: uiHeaders(),
        body: JSON.stringify({
          message: draft,
          ...(attachments.length ? { attachments } : {}),
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      setReplies((prev) => ({ ...prev, [id]: '' }))
      setReplyFiles((prev) => ({ ...prev, [id]: [] }))
      setTasks((await loadShownTasks(shown, view === 'archived')).tasks)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSendingBy((prev) => ({ ...prev, [id]: false }))
      // Disabling the textarea while sending drops its focus; restore it once
      // the element re-enables so you can keep typing the next reply.
      requestAnimationFrame(() => composerRef.current?.focus())
    }
  }

  // Answer an ask (a choice option, confirm yes/no, or free text). The server
  // stamps the answer and un-wedges — or schedules the delivery for a future
  // option `at` — then re-drives the session; here we just post and refresh.
  // Per-task in-flight disabling mirrors the send path (sendingBy).
  async function answerAsk(
    askId: string,
    body: { optionId?: string; text?: string },
  ) {
    if (!current) return
    const id = current.id
    const proj = current.projectSlug
    if (answeringBy[id]) return
    setAnsweringBy((prev) => ({ ...prev, [id]: true }))
    setError(null)
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}/asks/${askId}/answer`, {
        method: 'POST',
        headers: uiHeaders(),
        body: JSON.stringify(body),
      })
      const resBody = await r.json()
      if (!r.ok) throw new Error(resBody.error ?? r.statusText)
      setTasks((await loadShownTasks(shown, view === 'archived')).tasks)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAnsweringBy((prev) => ({ ...prev, [id]: false }))
    }
  }

  // Grant a permission rule: "task" scope persists the rule on the task (used on
  // future turns), "project" scope writes it to the project's settings.local.json.
  // Refresh so a task-scoped grant shows up. Returns whether the grant landed, so
  // a caller (the blocked-summary rows) can mark the row granted only on success.
  // The rule may have been hand-edited before granting.
  async function allowTool(
    rule: string,
    scope: 'task' | 'project',
  ): Promise<boolean> {
    if (!current) return false
    const id = current.id
    const proj = current.projectSlug
    setError(null)
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}/allow`, {
        method: 'POST',
        headers: uiHeaders(),
        body: JSON.stringify({ rule, scope }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      // A codex task-scope grant succeeds but comes back with a parity warning;
      // surface it without treating the grant as failed.
      if (typeof body.warning === 'string') setError(body.warning)
      if (scope === 'task')
        setTasks((await loadShownTasks(shown, view === 'archived')).tasks)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    }
  }

  async function setAllowEdits(checked: boolean) {
    if (!current) return
    const id = current.id
    const proj = current.projectSlug
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, allowEdits: checked } : t)),
    )
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}`, {
        method: 'PATCH',
        headers: uiHeaders(),
        body: JSON.stringify({ allowEdits: checked }),
      })
      if (!r.ok) {
        const body = await r.json()
        throw new Error(body.error ?? r.statusText)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function setStatus(task: TaskWithProject, status: string) {
    const id = task.id
    const proj = task.projectSlug
    setError(null)
    // Optimistic; the PATCH persists it and polling will reconcile.
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status } : t)),
    )
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (!r.ok) {
        const body = await r.json()
        throw new Error(body.error ?? r.statusText)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Archive (or restore) a task by moving it between the project's tasks/ and
  // archived/ dirs. The list shows only active tasks or only archived ones, so
  // either action moves the row out of the current view: optimistically drop it
  // from the list. A reload reconciles.
  async function archiveTask(task: TaskWithProject, archived: boolean) {
    const id = task.id
    const proj = task.projectSlug
    setError(null)
    setTasks((prev) => prev.filter((t) => t.id !== id))
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}/archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ archived }),
      })
      if (!r.ok) {
        const body = await r.json()
        throw new Error(body.error ?? r.statusText)
      }
      setTasks((await loadShownTasks(shown, view === 'archived')).tasks)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Archive every task in a section at once (the section header's kebab). A
  // section is a status, or — when the status is broken out into date buckets —
  // a single status+date bucket, so passing a category narrows the targets to
  // that date range. Drops them all optimistically, fires the per-task archive
  // calls in parallel, then reloads to reconcile — including any that failed,
  // which the reload brings back. Only offered for non-riding sections (a riding
  // task has a live run the server won't archive), so every target is archivable.
  async function archiveSection(status: string, category?: DateCategory) {
    const targets = orderedTasks.filter(
      (t) =>
        t.status === status &&
        (category == null ||
          dateCategory(t.updatedAt ?? t.createdAt, todayStart, weekStart) ===
            category),
    )
    if (targets.length === 0) return
    const ids = new Set(targets.map((t) => t.id))
    setError(null)
    setTasks((prev) => prev.filter((t) => !ids.has(t.id)))
    try {
      await Promise.all(
        targets.map(async (t) => {
          const r = await fetch(`/api/${t.projectSlug}/tasks/${t.id}/archive`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ archived: true }),
          })
          if (!r.ok) {
            const body = await r.json()
            throw new Error(body.error ?? r.statusText)
          }
        }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setTasks((await loadShownTasks(shown, view === 'archived')).tasks)
  }

  // Launch a scheduled task now, ahead of its time (the header's "launch"
  // button). The server clears the schedule, records the launch, and starts the
  // agent; polling reconciles the new status.
  async function launchNow(task: TaskWithProject) {
    const id = task.id
    const proj = task.projectSlug
    setError(null)
    // Optimistic: drop the schedule and flip to riding so the button clears at
    // once and the launch button gives way to the resting one.
    setTasks((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status: 'riding', scheduledFor: undefined }
          : t,
      ),
    )
    try {
      const r = await fetch(`/api/${proj}/tasks/${id}/launch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
      if (!r.ok) {
        const body = await r.json()
        throw new Error(body.error ?? r.statusText)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function onReplyKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Plain Enter sends; Shift+Enter / Option(Alt)+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      void sendReply()
    }
  }

  // Dropdown summary: "All projects" when every project is shown, otherwise the
  // single shown project's leaf (just the last path segment — the menu items
  // still show full paths). The active time filter ("Today"/"This week", not
  // "Any time") and the non-default views ("Unread"/"Archived", not the "Inbox"
  // default) each append a "• …" suffix, in that order (e.g. "All projects •
  // Today • Unread").
  const filterBase =
    projects.length === 0
      ? ''
      : allShown && projects.length > 1
        ? 'All projects'
        : shown.length === 1
          ? lastPathComponent(pathBySlug.get(shown[0]) ?? shown[0])
          : `${shown.length} of ${projects.length}`
  const timeLabel =
    timeFilter === 'today'
      ? 'Today'
      : timeFilter === 'week'
        ? 'This week'
        : timeFilter === 'older'
          ? 'Older'
          : ''
  const viewLabel =
    view === 'unread' ? 'Unread' : view === 'archived' ? 'Archived' : ''
  // The base (project name) and the time/view suffixes are rendered as separate
  // spans so the name can carry heavier weight than the suffixes (see CSS).
  const filterSuffixes = [timeLabel, viewLabel].filter(Boolean)

  // Keep the page title in sync with the project-select label text.
  const filterLabel = [filterBase, ...filterSuffixes].filter(Boolean).join(' • ')
  useEffect(() => {
    document.title = filterLabel || 'lander'
  }, [filterLabel])

  return (
    <div className="layout">
      <div className="sidebar">
        {projects.length > 0 && (
          <div className="project-filter" ref={menuRef}>
            <button
              type="button"
              className="project-select"
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
            >
              <span className="project-select-label">
                {filterBase && (
                  <span className="project-select-name">{filterBase}</span>
                )}
                {filterSuffixes.map((s) => (
                  <span key={s} className="project-select-suffix">
                    {' • '}
                    {s}
                  </span>
                ))}
              </span>
              <svg
                className="project-select-caret"
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden
              >
                <path
                  d="m6 9 6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {menuOpen && (
              <div className="project-menu" role="listbox">
                {projects.map((p) => (
                  <button
                    key={p.slug}
                    type="button"
                    role="option"
                    aria-selected={shown.includes(p.slug)}
                    className="project-menu-item"
                    onClick={() => showOnly(p.slug)}
                  >
                    <span className="project-menu-check">
                      {shown.includes(p.slug) ? '✓' : ''}
                    </span>
                    <span className="project-menu-path">{p.path}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className="project-menu-item project-menu-all"
                  onClick={showAll}
                >
                  <span className="project-menu-check">
                    {allShown ? '✓' : ''}
                  </span>
                  <span className="project-menu-path">All projects</span>
                </button>
                {(
                  [
                    ['today', 'Today'],
                    ['week', 'This week'],
                    ['older', 'Older'],
                    ['any', 'Any time'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className="project-menu-item project-menu-time"
                    role="menuitemradio"
                    aria-checked={timeFilter === value}
                    onClick={() => {
                      setTimeFilter(value)
                      setMenuOpen(false)
                    }}
                  >
                    <span className="project-menu-check">
                      {timeFilter === value ? '✓' : ''}
                    </span>
                    <span className="project-menu-path">{label}</span>
                  </button>
                ))}
                {(
                  [
                    ['inbox', 'Inbox'],
                    ['unread', 'Unread'],
                    ['archived', 'Archived'],
                  ] as const
                ).map(([value, label], i) => (
                  <button
                    key={value}
                    type="button"
                    className={
                      'project-menu-item project-menu-view' +
                      (i === 0 ? ' project-menu-view-first' : '')
                    }
                    role="menuitemradio"
                    aria-checked={view === value}
                    onClick={() => {
                      setView(value)
                      setMenuOpen(false)
                    }}
                  >
                    <span className="project-menu-check">
                      {view === value ? '✓' : ''}
                    </span>
                    <span className="project-menu-path">{label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="task-toolbar">
          {projects.length > 0 && statusCounts.length > 0 && (
            <div className="task-counts">
              {statusCounts.map(([status, count]) => (
                <button
                  key={status}
                  type="button"
                  className={'task-count ' + status}
                  onClick={() => scrollToStatus(status)}
                >
                  <span className="task-count-num">{count}</span> {status}
                </button>
              ))}
            </div>
          )}
          <input
            ref={searchInputRef}
            type="search"
            className="task-search"
            placeholder="Search tasks (⌘⇧F)"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <ul
          ref={taskListRef}
          className="task-list"
          role="listbox"
          aria-label="Tasks"
          onFocus={() => setListFocused(true)}
          onBlur={(e) => {
            // focusout bubbles, so this fires when focus hops between rows too;
            // only count it as leaving when the new target is outside the list
            // (a text field, another pane, or — with a null target — the window).
            if (!e.currentTarget.contains(e.relatedTarget as Node | null))
              setListFocused(false)
          }}
        >
          {tasks.length === 0 && (
            <li className="empty" role="presentation">No tasks yet</li>
          )}
          {tasks.length > 0 && orderedTasks.length === 0 && (
            <li className="empty" role="presentation">No matching tasks</li>
          )}
          {taskRows.map((row, ri) => {
            // Faint rules bracket each contiguous run of task rows around the
            // headers. The header→tasks rule (rule-below) rides on the header so it
            // pins with it in sticky mode. The tasks→header rule rides in the flow
            // just above the header as its own <li>, so it scrolls up and out of
            // view as the header pins (no separator between stacked sticky headers)
            // and keeps clear of the header text below it.
            const prevIsTask = ri > 0 && taskRows[ri - 1].kind === 'task'
            const nextIsTask =
              ri < taskRows.length - 1 && taskRows[ri + 1].kind === 'task'
            if (row.kind === 'status') {
              return (
                <Fragment key={row.key}>
                  <li
                    ref={(el) => {
                      if (el) sectionAnchorRefs.current.set(row.status, el)
                      else sectionAnchorRefs.current.delete(row.status)
                    }}
                    className={
                      'task-section-anchor' + (row.first ? ' first' : '')
                    }
                    role="presentation"
                    aria-hidden="true"
                  />
                  {prevIsTask && (
                    <li
                      className="task-rule"
                      role="presentation"
                      aria-hidden="true"
                    />
                  )}
                  <li
                    role="presentation"
                    className={
                      'task-group-header status ' +
                      row.status +
                      (row.first ? ' first' : '') +
                      ((dateCatsByStatus.get(row.status)?.size ?? 0) > 1
                        ? ' split'
                        : '') +
                      (nextIsTask ? ' rule-below' : '')
                    }
                  >
                    <span className="task-group-label">{row.status}</span>
                    {/* The archive menu rides the leaf header: here only when the
                        status isn't broken out into dates (otherwise each date
                        subheader carries its own, below). A riding task has a live
                        run the server won't archive, so that section gets none;
                        the archived view is already the archive, so it gets none
                        either. */}
                    {view !== 'archived' &&
                      row.status !== 'riding' &&
                      (dateCatsByStatus.get(row.status)?.size ?? 0) <= 1 && (
                        <SectionActionsMenu
                          count={countByStatus.get(row.status) ?? 0}
                          onArchive={() => archiveSection(row.status)}
                        />
                      )}
                  </li>
                </Fragment>
              )
            }
            if (row.kind === 'date') {
              return (
                <Fragment key={row.key}>
                  {prevIsTask && (
                    <li
                      className="task-rule"
                      role="presentation"
                      aria-hidden="true"
                    />
                  )}
                  <li
                    role="presentation"
                    className={
                      'task-group-header date ' +
                      row.status +
                      (row.first ? ' first' : '') +
                      (nextIsTask ? ' rule-below' : '')
                    }
                  >
                    <span className="task-group-label">
                      {DATE_CATEGORY_LABELS[row.category]}
                    </span>
                    {/* The leaf header for a date-broken status: its menu
                        archives only this status+date bucket. Riding never breaks
                        out a menu (live runs); archived view shows none. */}
                    {view !== 'archived' && row.status !== 'riding' && (
                      <SectionActionsMenu
                        count={
                          countByStatusDate.get(
                            `${row.status}|${row.category}`,
                          ) ?? 0
                        }
                        onArchive={() =>
                          archiveSection(row.status, row.category)
                        }
                      />
                    )}
                  </li>
                </Fragment>
              )
            }
            const { task, index } = row
            const unseen = isUnread(task)
            // Any armed scheduled message — a deferred relaunch, a plain deferred
            // send (`lander send --date/--time/--await`), or a repeating relaunch —
            // shows the clock. Earlier this keyed only off relaunch-flagged
            // messages, so a plain deferred send (deliverAt/waitFor, no relaunch
            // flag) armed no indicator at all.
            const pendingScheduled = task.scheduledMessages?.[0]
            return (
            <li
              key={row.key}
              ref={(el) => {
                taskItemRefs.current[index] = el
              }}
              role="option"
              aria-selected={task.id === selected}
              tabIndex={index === rovingIndex ? 0 : -1}
              className={
                'task-item' +
                (task.id === selected ? ' selected' : '') +
                ' ' +
                task.status +
                (task.archived ? ' archived' : '') +
                (unseen ? ' unread' : '')
              }
              onClick={() => selectTask(task.id, task.projectSlug)}
              onKeyDown={(e) => onTaskKeyDown(e, index, task)}
            >
              <div className="task-item-main">
                <div className="task-title-row">
                  {unseen && (
                    <span
                      className="unseen-dot"
                      aria-label="Unviewed updates"
                      title="Unviewed updates"
                    />
                  )}
                  <div className="task-title">{task.title}</div>
                  {showProjectLabels && (
                    <span className="task-project">
                      {lastPathComponent(
                        pathBySlug.get(task.projectSlug) ?? task.projectSlug,
                      )}
                    </span>
                  )}
                </div>
                {task.archived && (
                  <div className="task-meta-row">
                    <span className="task-archived-tag">archived</span>
                  </div>
                )}
                <div className="task-time">
                  {formatTaskTime(task.updatedAt ?? task.createdAt, todayStart)}
                  {(task.scheduledFor ||
                    (task.waitingFor && task.waitingFor.length > 0) ||
                    pendingScheduled) && (
                    <svg
                      className="scheduled-clock"
                      width="11"
                      height="11"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-label={
                        task.scheduledFor || pendingScheduled?.deliverAt
                          ? 'Scheduled'
                          : 'Awaiting'
                      }
                    >
                      <circle cx="8" cy="8" r="6" />
                      <path d="M8 4.5V8l2.5 1.5" />
                    </svg>
                  )}
                  {task.scheduledMessages?.some((m) => m.repeat) && (
                    <svg
                      className="repeat-arrow"
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-label="Repeats"
                    >
                      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                      <path d="M21 3v5h-5" />
                    </svg>
                  )}
                  {task.status === 'riding' && (
                    <span className="riding-spinner" aria-label="Riding" />
                  )}
                </div>
              </div>
              <TaskActionsMenu
                task={task}
                onAction={(action) => {
                  if (action === 'launch') void launchNow(task)
                  else if (action === 'wedge') void setStatus(task, 'wedged')
                  else if (action === 'rest') void setStatus(task, 'resting')
                  else if (action === 'land') void setStatus(task, 'landed')
                  else if (action === 'copyId')
                    void navigator.clipboard.writeText(task.id).catch(() => {})
                  else if (action === 'markUnread') void markUnread(task.id)
                  else if (action === 'archive') void archiveTask(task, true)
                  else if (action === 'restore') void archiveTask(task, false)
                }}
              />
            </li>
            )
          })}
        </ul>

        <ResizeHandle
          height={newTaskHeight}
          setHeight={setNewTaskHeight}
          min={150}
          reserveTop={160}
          label="Resize new task area"
        />
        <form
          className={`new-task${newMessageDrop.active ? ' file-drop-active' : ''}`}
          onSubmit={onSubmit}
          style={{ height: newTaskHeight }}
          {...newMessageDrop.handlers}
        >
          <div className="new-task-head">
            <h2>New task</h2>
            <select
              className="new-task-agent"
              value={newTaskAgent}
              onChange={(e) => setNewTaskAgent(e.target.value as Task['agent'])}
            >
              <option value="claude">Claude</option>
              <option value="codex">Codex</option>
            </select>
            {projects.length > 1 && (
              <select
                className="new-task-project"
                value={targetSlug}
                onChange={(e) => setNewProject(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {lastPathComponent(p.path)}
                  </option>
                ))}
              </select>
            )}
          </div>
          <textarea
            placeholder="Message"
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={onMessageKeyDown}
          />
          <div className="composer-actions">
            <AttachButton
              files={newFiles}
              onAdd={(picked) => setNewFiles((prev) => [...prev, ...picked])}
              onClear={() => setNewFiles([])}
              disabled={submitting}
            />
            <button
              type="submit"
              className="launch-btn"
              disabled={submitting || !message.trim()}
            >
              {submitting ? 'Launching…' : 'Launch'}
            </button>
          </div>
        </form>

        <TelemetryPanel
          items={telemetry[current?.agent ?? newTaskAgent] ?? []}
        />
      </div>

      <div className="detail">
        {error && <div className="error">{error}</div>}
        {current ? (
          <>
            <div className="detail-header">
              {(projects.length > 1 || worktreeName(current.cwd)) && (
                <div className="detail-project">
                  {lastPathComponent(
                    pathBySlug.get(current.projectSlug) ??
                      current.projectSlug,
                  )}
                  {worktreeName(current.cwd) &&
                    ` • ${worktreeName(current.cwd)}`}
                </div>
              )}
              {editingTitle ? (
                <input
                  ref={titleInputRef}
                  className="title-input"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={onTitleKeyDown}
                  onBlur={() => setEditingTitle(false)}
                />
              ) : (
                <div className="title-row">
                  <h1
                    className="editable-title"
                    title="Click to edit title"
                    onClick={startTitleEdit}
                  >
                    {current.title}
                  </h1>
                  <button
                    className="edit-title-button"
                    title="Regenerate title"
                    aria-label="Regenerate title"
                    disabled={retitling === current.id}
                    onClick={() => void generateTitle()}
                  >
                    <svg
                      width="15"
                      height="15"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M8 1.5l1.4 3.6 3.6 1.4-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4z" />
                      <path d="M13 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
                    </svg>
                  </button>
                  <CopyIdButton id={current.id} />
                  {!current.archived && (
                    <GrantControl grants={current.grants} onAllow={allowTool} />
                  )}
                  {!current.allowEdits && !current.archived && (
                    <ReadOnlyMenu
                      onAllowEdits={() => void setAllowEdits(true)}
                    />
                  )}
                  <TaskActionsMenu
                    task={current}
                    onAction={(action) => {
                      if (action === 'launch') void launchNow(current)
                      else if (action === 'wedge')
                        void setStatus(current, 'wedged')
                      else if (action === 'rest')
                        void setStatus(current, 'resting')
                      else if (action === 'land')
                        void setStatus(current, 'landed')
                      else if (action === 'copyId')
                        void navigator.clipboard
                          .writeText(current.id)
                          .catch(() => {})
                      else if (action === 'markUnread')
                        void markUnread(current.id)
                      else if (action === 'archive')
                        void archiveTask(current, true)
                      else if (action === 'restore')
                        void archiveTask(current, false)
                    }}
                  />
                </div>
              )}
              <div className="detail-meta">
                <span
                  className={
                    'task-status' +
                    (current.status === 'wedged' ? ' wedged' : '') +
                    (current.status === 'riding' ? ' riding' : '') +
                    (current.status === 'resting' ? ' resting' : '') +
                    (current.status === 'landed' ? ' landed' : '')
                  }
                >
                  {current.status}
                </span>
                <span className="task-time">
                  {formatTimestamp(current.updatedAt ?? current.createdAt)}
                </span>
              </div>
            </div>
            <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
              {timeline.map((entry) => {
                if (entry.kind === 'event') {
                  return (
                    <StatusTransition
                      key={`e-${entry.event.id}`}
                      event={entry.event}
                      slug={current.projectSlug}
                      linkTask={resolveTaskLink}
                    />
                  )
                }
                if (entry.kind === 'user') {
                  const m = entry.item
                  return (
                    <div
                      className={`message message-user${m.queued ? ' message-queued' : ''}`}
                      key={`u-${m.id}`}
                    >
                      <div className="message-head">
                        <span className="message-role">user</span>
                        <span className="message-time">
                          {formatTimestamp(m.at)}
                        </span>
                      </div>
                      <MessageText text={m.text} linkTask={resolveTaskLink} />
                      {m.attachments && m.attachments.length > 0 && (
                        <MessageAttachments
                          attachments={m.attachments}
                          slug={current.projectSlug}
                        />
                      )}
                    </div>
                  )
                }
                // A ride — one assistant turn, carrying all its items.
                const ride = entry.ride
                const items = entry.items
                const settled = !!ride.endedAt
                return (
                <div className="message message-assistant" key={`r-${ride.id}`}>
                  <div className="message-head">
                    <span className="message-role">assistant</span>
                    <span className="message-time">
                      {formatTimestamp(ride.startedAt)}
                    </span>
                  </div>
                  <div className="steps">
                    {(() => {
                      // Subagent items (parentId set) don't render inline — they
                      // fold into their spawning tool chip. Map each spawning tool
                      // id to its direct children's indices so renderItem can nest
                      // them; the links go arbitrarily deep, so rendering a child
                      // recurses on its own children in turn.
                      const childrenByParent = new Map<string, number[]>()
                      items.forEach((it, j) => {
                        if (it.parentId) {
                          const sibs = childrenByParent.get(it.parentId)
                          if (sibs) sibs.push(j)
                          else childrenByParent.set(it.parentId, [j])
                        }
                      })
                      // The main thread: items with no parent. Subagent items are
                      // folded under their spawning chip, so they never open a
                      // main-thread group nor feed collapse/copy controls.
                      const mainIdxs = items
                        .map((_, j) => j)
                        .filter((j) => !items[j].parentId)
                      // Ids of every tool chip with revealable detail (full input, a
                      // diff, captured output, or a nested subagent trace) in this
                      // ride, so an option/shift-click on one toggles them all
                      // together — nested chips included, since ids are ride-wide.
                      const detailKeys = items
                        .map((it) =>
                          it.kind === 'tool' &&
                          (it.inputFull ||
                            it.input.includes('\n') ||
                            it.edits?.length ||
                            it.output ||
                            childrenByParent.has(it.id))
                            ? it.id
                            : null,
                        )
                        .filter((k): k is string => k !== null)
                      // Group consecutive main items by the groupId that produced
                      // them: an item whose groupId differs from the last opens a
                      // new group. Items without one stay with the current group.
                      // Each group is one inference — ruled apart from the next.
                      const groupByGroup = (idxs: number[]): number[][] => {
                        const gs: number[][] = []
                        let last: string | undefined
                        for (const j of idxs) {
                          const it = items[j]
                          if (
                            gs.length === 0 ||
                            (it.groupId &&
                              last !== undefined &&
                              it.groupId !== last)
                          )
                            gs.push([])
                          gs[gs.length - 1].push(j)
                          if (it.groupId) last = it.groupId
                        }
                        return gs
                      }
                      const renderItem = (j: number) => {
                        const it = items[j]
                        if (it.kind === 'tool') {
                          // A subagent spawner (Agent/Explore) carries its
                          // subagent's items as children; render them as the chip's
                          // nested trace. renderItem recurses, so a sub-subagent's
                          // own chips nest in turn.
                          const childIdxs = childrenByParent.get(it.id)
                          const subItems = childIdxs?.length
                            ? renderSubItems(childIdxs)
                            : undefined
                          return (
                            <ToolStep
                              key={it.id}
                              item={it}
                              detailOpen={openDetails.has(it.id)}
                              onToggleDetail={(all) =>
                                toggleDetail(it.id, all ? detailKeys : [it.id])
                              }
                              subItems={subItems}
                            />
                          )
                        }
                        if (it.kind === 'message') {
                          // A flow message item: its prose. The open ask renders
                          // as the whole turn's footer (below), not inline — its
                          // parentId is the last flow item at wedge time, which
                          // may sit before later prose in the same turn.
                          return (
                            <MessageText
                              key={it.id}
                              text={it.text}
                              linkTask={resolveTaskLink}
                            />
                          )
                        }
                        return null
                      }
                      const renderItemList = (
                        idxs: number[],
                        keyPrefix = 'items',
                      ) =>
                        groupByGroup(idxs).map((groupIdxs, k) => (
                          <Fragment
                            key={`${keyPrefix}-${k}-${groupIdxs[0] ?? 'empty'}`}
                          >
                            {k > 0 && <hr className="turn-sep" />}
                            <div className="inference">
                              {groupIdxs.map(renderItem)}
                            </div>
                          </Fragment>
                        ))
                      // A subagent's folded trace, grouped into its own turns the
                      // same way the main thread is. Mutually recursive with
                      // renderItem (a nested subagent nests in turn).
                      const renderSubItems = (childIdxs: number[]) =>
                        renderItemList(childIdxs, `sub-${childIdxs[0] ?? 'empty'}`)
                      // Settled turns fold down by their flow messages, independent
                      // of group boundaries: keep the opening prose before the first
                      // tool, the longest text sequence, and the last, collapsing
                      // the ranges between (see planTurnCollapse). An open ride
                      // renders in full (its shape isn't settled yet), as does any
                      // turn too short to have a gap.
                      const collapse = planTurnCollapse(items, mainIdxs)
                      const folds =
                        settled && collapse.segments.some((seg) => seg.hidden)
                      if (!folds) return renderItemList(mainIdxs)
                      return (
                        <>
                          {collapse.segments.map((seg, si) => {
                            const sep = si > 0 && <hr className="turn-sep" />
                            if (!seg.hidden)
                              return (
                                <Fragment key={`seg-${si}`}>
                                  {sep}
                                  {renderItemList(seg.indices, `seg-${si}`)}
                                </Fragment>
                              )
                            // Each hidden segment folds independently, keyed by
                            // ride + segment index.
                            const segKey = `${ride.id}:${si}`
                            const open = expandedTurns.has(segKey)
                            // Summarize as the model's actions: one "step" per
                            // inference group (the runs a turn-sep rules apart, so
                            // groups = turn-seps + 1), plus the tool count.
                            const stepCount = groupByGroup(seg.indices).length
                            const toolCount = seg.indices.filter(
                              (j) => items[j].kind === 'tool',
                            ).length
                            return (
                              <Fragment key={`seg-${si}`}>
                                {sep}
                                <Collapsible
                                  open={open}
                                  onToggle={() => toggleTurn(segKey)}
                                  label={
                                    <span className="collapsible-label">
                                      {stepCount} step
                                      {stepCount === 1 ? '' : 's'}
                                      {toolCount > 0 &&
                                        `, ${toolCount} tool${
                                          toolCount === 1 ? '' : 's'
                                        }`}
                                      …
                                    </span>
                                  }
                                >
                                  {renderItemList(seg.indices, `hidden-${si}`)}
                                </Collapsible>
                              </Fragment>
                            )
                          })}
                        </>
                      )
                    })()}
                  </div>
                  {/* A finished turn's confirmed denials, distilled into a review
                      surface. Only when the ride is settled (denials are
                      authoritative at ride end, so an open ride shows nothing) and
                      only when there are any — a task whose agent never reports
                      denials simply has no line. */}
                  {settled &&
                    (() => {
                      const requests = blockedRequests(items)
                      return requests.length > 0 ? (
                        <BlockedSummary
                          requests={requests}
                          grants={current.grants}
                          onAllow={allowTool}
                        />
                      ) : null
                    })()}
                  {/* The in-flight turn's working spinner, after the ride's last
                      item — an open ride (no endedAt) is streaming. */}
                  {!settled && (
                    <div className="message-pending">
                      <span className="spinner" aria-hidden />
                      {`${taskAgentModelName(current.agent, ride.usage?.model)} is working…`}
                    </div>
                  )}
                  {/* Artifacts the turn published, gathered from its flow items and
                      shown at the bottom — below the working spinner, as before. */}
                  {(() => {
                    const arts = items.flatMap((it) =>
                      it.kind === 'message' ? (it.artifacts ?? []) : [],
                    )
                    return arts.length > 0 ? (
                      <MessageArtifacts
                        artifacts={arts}
                        taskId={current.id}
                        slug={current.projectSlug}
                      />
                    ) : null
                  })()}
                  {/* The open ask's controls hang off the turn that raised it, as
                      its footer — at the very bottom of the bubble (its parentId
                      item may sit before later prose in the same turn). */}
                  {openAsk &&
                    openAsk.parentId !== undefined &&
                    items.some((it) => it.id === openAsk.parentId) && (
                      <AskForm
                        ask={openAsk}
                        linkTask={resolveTaskLink}
                        disabled={answeringBy[current.id] ?? false}
                        onAnswer={(body) => void answerAsk(openAsk.id, body)}
                      />
                    )}
                </div>
                )
              })}
              {/* No ride output yet but the task is riding: the assistant has been
                  launched and we're waiting for its first item. The model isn't
                  known until that output arrives, so this stays model-agnostic. */}
              {current.status === 'riding' && !openRideHasItems && (
                <div className="message">
                  <div className="message-pending">
                    <span className="spinner" aria-hidden />
                    {`${taskAgentModelName(current.agent)} is starting…`}
                  </div>
                </div>
              )}
              {/* Fallback: an open ask with no message item to anchor to (a
                  platform ask, or converted history) renders its form standalone. */}
              {openAsk &&
                !(
                  askAnchorId &&
                  current.items?.some((it) => it.id === askAnchorId)
                ) && (
                  <div className="message message-assistant">
                    <AskForm
                      ask={openAsk}
                      linkTask={resolveTaskLink}
                      disabled={answeringBy[current.id] ?? false}
                      onAnswer={(body) => void answerAsk(openAsk.id, body)}
                    />
                  </div>
                )}
            </div>
            <ResizeHandle
              height={composerHeight}
              setHeight={setComposerHeight}
              min={96}
              reserveTop={200}
              label="Resize reply area"
            />
            <div
              className={`composer-bar${replyDrop.active ? ' file-drop-active' : ''}`}
              style={{ height: composerHeight }}
              {...replyDrop.handlers}
            >
              <textarea
                ref={composerRef}
                className="composer"
                placeholder={
                  current.archived ? 'Restore this task to reply' : 'Reply…'
                }
                rows={3}
                value={replies[current.id] ?? ''}
                disabled={
                  (sendingBy[current.id] ?? false) || !!current.archived
                }
                onChange={(e) =>
                  setReplies((prev) => ({
                    ...prev,
                    [current.id]: e.target.value,
                  }))
                }
                onKeyDown={onReplyKeyDown}
              />
              <div className="allow-row">
                {!current.archived && (
                  <AttachButton
                    files={replyFiles[current.id] ?? []}
                    onAdd={(picked) =>
                      setReplyFiles((prev) => ({
                        ...prev,
                        [current.id]: [...(prev[current.id] ?? []), ...picked],
                      }))
                    }
                    onClear={() =>
                      setReplyFiles((prev) => ({ ...prev, [current.id]: [] }))
                    }
                    disabled={sendingBy[current.id] ?? false}
                  />
                )}
                {(() => {
                  const u = usageTotal
                    ? totalUsage(current)
                    : latestUsage(current)
                  if (!u) return null
                  const scope = usageTotal ? 'total' : 'turn'
                  // Absent on legacy payloads / fixtures without an agent — treat
                  // as cost-reporting (claude), matching the grants "fully capable"
                  // default.
                  const reportsCost = current.reportsCost ?? true
                  const costText =
                    u.costUsd !== undefined
                      ? `$${u.costUsd.toFixed(4)}`
                      : reportsCost
                        ? '… (available when the turn lands)'
                        : 'unavailable for Codex'
                  const items = taskUsageTelemetry(u, current.agent, reportsCost)
                  // The model names the whole task, not a scope, so it sits outside
                  // the turn/total toggle; the counts + cost are what the toggle flips.
                  const model = items.find((i) => i.id === 'model')
                  const stats = items.filter((i) => i.id !== 'model')
                  return (
                    <div className="telemetry-inline">
                      {model && <TelemetryItemView item={model} />}
                      <button
                        type="button"
                        className="telemetry-toggle"
                        onClick={() => setUsageTotal((v) => !v)}
                        title={
                          `${scope} — click to show ` +
                          `${usageTotal ? 'turn' : 'total'}\n` +
                          `uncached input ${u.input.toLocaleString()} ` +
                          `(+ ${u.cacheCreation.toLocaleString()} written to cache)\n` +
                          `cache read ${u.cacheRead.toLocaleString()}\n` +
                          // The turn's cache-miss diagnostic, when the API reported
                          // one (per-turn only; misses don't sum).
                          (!usageTotal && u.cacheMiss
                            ? `cache miss: ${u.cacheMiss.reason.replaceAll('_', ' ')} ` +
                              `(${u.cacheMiss.missedTokens.toLocaleString()} tokens missed)\n`
                            : '') +
                          `output ${u.output.toLocaleString()}\n` +
                          `cost ${costText}`
                        }
                      >
                        <span className="telemetry-scope">{scope}</span>
                        {stats.map((item) => (
                          <TelemetryItemView key={item.id} item={item} />
                        ))}
                      </button>
                    </div>
                  )
                })()}
              </div>
            </div>
          </>
        ) : (
          <div className="placeholder">Select a task</div>
        )}
      </div>
    </div>
  )
}
