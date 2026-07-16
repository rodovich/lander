import { Fragment, useEffect, useRef, useState } from 'react'
import { uiHeaders, uploadAttachments } from './api'
import { AskForm } from './asks'
import { AttachButton, MessageArtifacts, MessageAttachments } from './attachments'
import { clipboardImageFiles, dataTransferHasFiles } from './fileDrop'
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
import {
  CopyIdButton,
  ReadOnlyMenu,
  SectionActionsMenu,
  TaskActionsMenu,
} from './menus'
import { MessageText } from './messageText'
import { NewTaskForm } from './newTaskForm'
import { tick, timed } from './perf'
import { ProjectMenu, filterLabelParts } from './projectMenu'
import { blockedRequests } from './permissions'
import { ResizeHandle } from './resizeHandle'
import { StatusTransition } from './statusTransition'
import {
  isUnread,
  latestUsage,
  taskAgentModelName,
  taskUsageTelemetry,
  totalUsage,
} from './taskMeta'
import { buildTaskRows } from './taskRows'
import { useSeenMarker, useViewingState } from './useSeenMarker'
import { useTaskActions } from './useTaskActions'
import { useTaskData } from './useTaskData'
import { buildTimeline } from './timeline'
import type { TimelineEntry } from './timeline'
import { Collapsible, ToolStep } from './toolStep'
import { planTurnCollapse } from './turnCollapse'
import { TelemetryItemView, TelemetryPanel } from './telemetry'
import type {
  AskItem,
  DateCategory,
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
  // The list's task-slice filter (see TaskView), session-scoped so it survives
  // a reload but can differ per tab.
  const [view, setView] = useSessionState<TaskView>('lander:view', 'inbox')
  // The list's time-window filter (see TimeFilter), session-scoped alongside view.
  const [timeFilter, setTimeFilter] = useSessionState<TimeFilter>(
    'lander:timeFilter',
    'any',
  )
  const [error, setError] = useState<string | null>(null)
  // The task data proper: the displayed list and its polls, per-flow telemetry,
  // projects and the session's project filter, and mention-link resolution.
  const {
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
  } = useTaskData(view, setError)
  // The open task, readable by the actions at call time. Assigned below, once
  // the effective selection is derived from the shaped list.
  const currentRef = useRef<TaskWithProject | null>(null)
  const {
    markSeen,
    markUnread,
    setStatus,
    archiveTask,
    archiveSection,
    launchNow,
    allowTool,
    setAllowEdits,
    saveTitle,
    generateTitle,
    retitling,
    answerAsk,
    answeringBy,
  } = useTaskActions({ currentRef, tasksRef, setTasks, refresh, setError })
  // The user's explicit task pick. The effective selection (`selected`, below)
  // falls back to the first visible task when this one is filtered away.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    () => taskIdFromPath() || null,
  )
  // The list search box, session-scoped alongside the other list filters.
  const [filter, setFilter] = useSessionState('lander:filter', '')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // The new-task form's agent/project picks. Session-scoped like the form's
  // draft message (which lives in the form): two tabs keep independent picks,
  // and since these drive the submission, a shared newProject could even send
  // a task to the wrong project. They're lifted here rather than owned by the
  // form because App reads the agent for the telemetry panel and the project
  // menu writes the project on a single-project pick.
  const [newTaskAgent, setNewTaskAgent] = useSessionState<Task['agent']>(
    'lander:draft:newAgent',
    'claude',
  )
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

  // Each task keeps its own draft and in-flight state, keyed by id, so you
  // can start a reply in one task, switch away, and come back to finish it; the
  // drafts persist across reloads alongside the new-task message and, like it,
  // are session-scoped so two tabs don't clobber each other's reply drafts.
  const [replies, setReplies] = useSessionState<Record<string, string>>(
    'lander:draft:replies',
    {},
  )
  const [sendingBy, setSendingBy] = useState<Record<string, boolean>>({})
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // Files attached to per-task replies, held as File objects (not
  // session-persisted — File isn't serializable) and uploaded to the durable
  // store on submit. The paperclip <AttachButton> below the composer owns its
  // own hidden file input.
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

  // The ambient viewing signals (tab focus, scroll position, list focus) and
  // the sticky-unread set the Unread view's filter consumes.
  const { atBottom, setAtBottom, tabActive, setListFocused, stickyUnread } =
    useViewingState(view, tasks)

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  const pathBySlug = new Map(projects.map((p) => [p.slug, p.path]))
  // Tag each task row with its project's leaf only when more than one project's
  // tasks can be intermixed; with a single project shown it's just noise.
  const showProjectLabels = shown.length > 1

  // Shape the sidebar list from the raw tasks and the active filters (see
  // taskRows.ts). Recomputed each render so the time bucketing tracks the
  // wall clock.
  const query = filter.trim().toLowerCase()
  const {
    orderedTasks,
    taskRows,
    statusCounts,
    countByStatus,
    countByStatusDate,
    dateCatsByStatus,
    todayStart,
    weekStart,
  } = buildTaskRows(tasks, {
    view,
    timeFilter,
    query,
    stickyUnread,
    now: new Date(),
  })

  // The effective selection: the user's pick if it's still visible, otherwise
  // the first task in the list (e.g. after filtering hides the prior pick).
  const selected =
    selectedTaskId && tasks.some((t) => t.id === selectedTaskId)
      ? selectedTaskId
      : orderedTasks[0]?.id ?? null
  const current = tasks.find((t) => t.id === selected) ?? null
  currentRef.current = current

  // The whole reply panel is one drop target, including its textarea,
  // paperclip, and surrounding action area. Keep the target bound to the
  // task currently open so switching tasks cannot leak a dropped file into
  // another task's draft.
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

  // Advance the open task's seen marker per the viewing rules (the 2s dwell,
  // immediate marking while actively viewing).
  useSeenMarker({ current, atBottom, tabActive, markSeen })

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
  // open ask. An ask with no reachable `parentId` to hang under — a platform ask,
  // or converted history — isn't handled here at all: buildTimeline gives it its
  // own entry in the stream.
  const openAsk = current?.items?.find(
    (it): it is AskItem => it.kind === 'ask' && it.state === 'open',
  )

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

  function onTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      setEditingTitle(false)
      void saveTitle(titleDraft)
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
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSendingBy((prev) => ({ ...prev, [id]: false }))
      // Disabling the textarea while sending drops its focus; restore it once
      // the element re-enables so you can keep typing the next reply.
      requestAnimationFrame(() => composerRef.current?.focus())
    }
  }

  // Resolve a section (a status, or a single status+date bucket when the
  // status is broken out into dates) to the tasks its archive menu targets.
  function sectionTargets(status: string, category?: DateCategory) {
    return orderedTasks.filter(
      (t) =>
        t.status === status &&
        (category == null ||
          dateCategory(t.updatedAt ?? t.createdAt, todayStart, weekStart) ===
            category),
    )
  }

  function onReplyKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Plain Enter sends; Shift+Enter / Option(Alt)+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      void sendReply()
    }
  }

  // Keep the page title in sync with the project-select label text.
  const labelParts = filterLabelParts(projects, shown, timeFilter, view)
  const filterLabel = [labelParts.base, ...labelParts.suffixes]
    .filter(Boolean)
    .join(' • ')
  useEffect(() => {
    document.title = filterLabel || 'lander'
  }, [filterLabel])

  return (
    <div className="layout">
      <div className="sidebar">
        {projects.length > 0 && (
          <ProjectMenu
            projects={projects}
            shown={shown}
            setShown={setShown}
            view={view}
            setView={setView}
            timeFilter={timeFilter}
            setTimeFilter={setTimeFilter}
            onPickProject={setNewProject}
          />
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
                          onArchive={() =>
                            archiveSection(sectionTargets(row.status))
                          }
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
                          archiveSection(
                            sectionTargets(row.status, row.category),
                          )
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
        <NewTaskForm
          projects={projects}
          shown={shown}
          currentProjectSlug={current?.projectSlug}
          agent={newTaskAgent}
          setAgent={setNewTaskAgent}
          newProject={newProject}
          setNewProject={setNewProject}
          height={newTaskHeight}
          setError={setError}
          refresh={refresh}
          onCreated={selectTask}
        />

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
                if (entry.kind === 'ask') {
                  // A platform ask, standing where it was raised: its prompt is
                  // the account of what happened, and AskForm drops the buttons
                  // once it's no longer open. It carries a head like every other
                  // row because it outlives its form — a bare sentence with no
                  // time on it reads as floating loose in the conversation rather
                  // than as the record of a moment.
                  return (
                    <div
                      className="message message-platform"
                      key={`a-${entry.ask.id}`}
                    >
                      <div className="message-head">
                        <span className="message-role">lander</span>
                        <span className="message-time">
                          {formatTimestamp(entry.ask.at)}
                        </span>
                      </div>
                      <AskForm
                        ask={entry.ask}
                        linkTask={resolveTaskLink}
                        disabled={answeringBy[current.id] ?? false}
                        onAnswer={(body) => void answerAsk(entry.ask.id, body)}
                      />
                    </div>
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
                onPaste={(e) => {
                  const images = clipboardImageFiles(e.clipboardData)
                  if (images.length === 0) return
                  e.preventDefault()
                  const id = current.id
                  setReplyFiles((prev) => ({
                    ...prev,
                    [id]: [...(prev[id] ?? []), ...images],
                  }))
                }}
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
