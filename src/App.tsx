import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Composer } from './composer'
import { Conversation } from './conversation'
import { dataTransferHasFiles } from './fileDrop'
import { lastPathComponent, worktreeName } from './format'
import { usePersistentState, useSessionState } from './hooks'
import { HooksPanel } from './hooksPanel'
import type { TaskAction } from './menus'
import { NewTaskForm } from './newTaskForm'
import { tick } from './perf'
import { ProjectMenu, filterLabelParts } from './projectMenu'
import { ResizeHandle } from './resizeHandle'
import { TaskList } from './taskList'
import { buildTaskRows } from './taskRows'
import { TelemetryPanel } from './telemetry'
import { useSeenMarker, useViewingState } from './useSeenMarker'
import { useTaskActions } from './useTaskActions'
import { useTaskData } from './useTaskData'
import {
  taskHref,
  taskKey,
  taskKeyOf,
  migrateLegacyTaskValues,
  taskRefFromPath,
  type TaskRef,
} from './taskRef'
import type { Task, TaskView, TaskWithProject, TimeFilter } from './types'

export function App() {
  // Opt-in profiling (see perf.ts): count every App render. The 2s poll,
  // streaming updates, and every scroll/tab-focus state change all trip it —
  // but the memoized panes (Conversation, TaskList, …) hold still unless
  // their own props changed, so compare against their counters to see where
  // churn actually lands.
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
  const initialTaskRef = useRef<TaskRef | null>(taskRefFromPath())
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
    taskLinks,
    taskLinksLoaded,
  } = useTaskData(view, setError, initialTaskRef.current?.projectSlug)
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
  const initialTaskKey = initialTaskRef.current
    ? taskKey(initialTaskRef.current.projectSlug, initialTaskRef.current.id)
    : null
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(
    initialTaskKey,
  )
  const [pendingRouteKey, setPendingRouteKey] = useState<string | null>(
    initialTaskKey,
  )
  // The list search box, session-scoped alongside the other list filters.
  const [filter, setFilter] = useSessionState('lander:filter', '')
  // The project whose hook settings are open in the detail pane, or null for the
  // ordinary conversation view. Not persisted: it is a place you go, not a mode
  // the app should still be in tomorrow.
  const [hooksProject, setHooksProject] = useState<string | null>(null)

  // Reply ownership stays above the conditionally-mounted composer. Keys are
  // project-qualified, so equal task ids in different projects never share a
  // draft, attachment set, or in-flight send flag.
  const [replies, setReplies] = useSessionState<Record<string, string>>(
    'lander:draft:replies',
    {},
  )
  const [sendingBy, setSendingBy] = useState<Record<string, boolean>>({})
  const [replyFiles, setReplyFiles] = useState<Record<string, File[]>>({})

  // The new-task form's agent/project picks. Session-scoped like the form's
  // draft message (which lives in the form): two tabs keep independent picks,
  // and since these drive the submission, a shared newProject could even send
  // a task to the wrong project. They're lifted here rather than owned by the
  // form because App reads the agent for the telemetry panel and the project
  // menu writes the project on a single-project pick.
  const [newTaskFlow, setNewTaskFlow] = useSessionState<string>(
    'lander:draft:newFlow',
    'claude',
  )
  const [newProject, setNewProject] = useSessionState(
    'lander:draft:newProject',
    '',
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

  // The ambient viewing signals (tab focus, scroll position, list focus) and
  // the sticky-unread set the Unread view's filter consumes.
  const { atBottom, setAtBottom, tabActive, setListFocused, stickyUnread } =
    useViewingState(view, tasks)

  const pathBySlug = useMemo(
    () => new Map(projects.map((p) => [p.slug, p.path])),
    [projects],
  )
  const taskLinkByKey = useMemo(
    () => new Map(taskLinks.map((link) => [taskKey(link.projectSlug, link.id), link])),
    [taskLinks],
  )

  // Drafts saved by an older client were keyed only by id. Migrate one only
  // when the global projection proves that id belongs to exactly one project;
  // an ambiguous legacy draft is left untouched rather than guessed onto the
  // wrong task.
  useEffect(() => {
    if (!taskLinksLoaded) return
    setReplies((prev) => migrateLegacyTaskValues(prev, taskLinks))
  }, [taskLinks, taskLinksLoaded, setReplies])
  // Tag each task row with its project's leaf only when more than one project's
  // tasks can be intermixed; with a single project shown it's just noise.
  const showProjectLabels = shown.length > 1

  // Shape the sidebar list from the raw tasks and the active filters (see
  // taskRows.ts). Keyed on the poll-refreshed tasks array (a fresh identity
  // every 2s), so the time bucketing still tracks the wall clock while
  // unrelated renders — scroll flips, menu state — reuse the shape and let the
  // memoized TaskList hold still.
  const query = filter.trim().toLowerCase()
  const listShape = useMemo(
    () =>
      buildTaskRows(tasks, {
        view,
        timeFilter,
        query,
        stickyUnread,
        now: new Date(),
      }),
    [tasks, view, timeFilter, query, stickyUnread],
  )
  const { orderedTasks } = listShape

  // The effective selection: the user's pick if it's still visible, otherwise
  // the first task in the list (e.g. after filtering hides the prior pick).
  const selected =
    selectedTaskKey &&
    (pendingRouteKey || tasks.some((t) => taskKeyOf(t) === selectedTaskKey))
      ? selectedTaskKey
      : orderedTasks[0]
        ? taskKeyOf(orderedTasks[0])
        : null
  const current = tasks.find((t) => taskKeyOf(t) === selected) ?? null
  currentRef.current = current

  // Advance the open task's seen marker per the viewing rules (the 2s dwell,
  // immediate marking while actively viewing).
  useSeenMarker({ current, atBottom, tabActive, markSeen })

  // "project • worktree" over the detail header's title; omitted with a single
  // project and no worktree, when it's just noise.
  const worktree = current ? worktreeName(current.cwd) : null
  const projectLabel =
    current && (projects.length > 1 || worktree)
      ? lastPathComponent(
          pathBySlug.get(current.projectSlug) ?? current.projectSlug,
        ) + (worktree ? ` • ${worktree}` : '')
      : null

  // Stable identities so the memoized panes receiving these don't re-render
  // on unrelated App state (the underlying setters and actions are stable).
  const selectTask = useCallback((id: string, projectSlug: string) => {
    setSelectedTaskKey(taskKey(projectSlug, id))
    setPendingRouteKey(null)
    // Picking a task is how you leave the hooks panel; it shares the pane.
    setHooksProject(null)
    window.history.pushState(null, '', taskHref(projectSlug, id))
  }, [])

  // The kebab-menu actions, shared by the list rows and the detail header.
  const onTaskAction = useCallback(
    (task: TaskWithProject, action: TaskAction) => {
      if (action === 'launch') void launchNow(task)
      else if (action === 'wedge') void setStatus(task, 'wedged')
      else if (action === 'rest') void setStatus(task, 'resting')
      else if (action === 'land') void setStatus(task, 'landed')
      else if (action === 'copyId')
        void navigator.clipboard.writeText(task.id).catch(() => {})
      else if (action === 'markUnread') void markUnread(taskKeyOf(task))
      else if (action === 'archive') void archiveTask(task, true)
      else if (action === 'restore') void archiveTask(task, false)
    },
    [launchNow, setStatus, markUnread, archiveTask],
  )

  const routeToTask = useCallback(
    (ref: TaskRef, push: boolean) => {
      const key = taskKey(ref.projectSlug, ref.id)
      const link = taskLinkByKey.get(key)
      setSelectedTaskKey(key)
      setPendingRouteKey(key)
      setHooksProject(null)
      setShown((prev) =>
        prev.includes(ref.projectSlug) ? prev : [ref.projectSlug],
      )
      if (link)
        setView((prev) =>
          link.archived ? 'archived' : prev === 'archived' ? 'inbox' : prev,
        )
      if (push)
        window.history.pushState(null, '', taskHref(ref.projectSlug, ref.id))
    },
    [setShown, setView, taskLinkByKey],
  )

  // A route intent holds the URL steady while its project/pool reloads. Once
  // the compact global index resolves it, select the right project and active
  // vs archived pool; an unknown route falls back only after that index loaded.
  useEffect(() => {
    if (!pendingRouteKey) return
    if (tasks.some((task) => taskKeyOf(task) === pendingRouteKey)) {
      setPendingRouteKey(null)
      return
    }
    const link = taskLinkByKey.get(pendingRouteKey)
    if (!link) {
      if (taskLinksLoaded) {
        setPendingRouteKey(null)
        setSelectedTaskKey((prev) => (prev === pendingRouteKey ? null : prev))
      }
      return
    }
    setShown((prev) =>
      prev.includes(link.projectSlug) ? prev : [link.projectSlug],
    )
    setView((prev) =>
      link.archived ? 'archived' : prev === 'archived' ? 'inbox' : prev,
    )
  }, [pendingRouteKey, setShown, setView, taskLinkByKey, taskLinksLoaded, tasks])

  // Task links are ordinary anchors for copy/open-in-new-tab semantics. Plain
  // clicks stay in-process so browser history, drafts, and file attachments all
  // survive a cross-project hop.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest<HTMLAnchorElement>('a[href]')
      if (!anchor || (anchor.target && anchor.target !== '_self')) return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      const ref = taskRefFromPath(url.pathname)
      if (!ref || !taskLinkByKey.has(taskKey(ref.projectSlug, ref.id))) return
      event.preventDefault()
      routeToTask(ref, true)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [routeToTask, taskLinkByKey])

  // Keep the selection in sync when navigating with the browser back/forward
  // buttons.
  useEffect(() => {
    const onPop = () => {
      const ref = taskRefFromPath()
      if (ref) routeToTask(ref, false)
      else {
        setSelectedTaskKey(null)
        setPendingRouteKey(null)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [routeToTask])

  // Mirror the effective selection into the URL as /<project>/<id>. Held
  // off until tasks have loaded so a deep-linked task isn't clobbered before
  // its project's tasks arrive. replaceState (not push) corrects the URL in
  // place without adding spurious history entries.
  useEffect(() => {
    if (!hasLoadedRef.current || pendingRouteKey) return
    const desired = current ? taskHref(current.projectSlug, current.id) : '/'
    if (window.location.pathname !== desired) {
      window.history.replaceState(null, '', desired)
    }
  }, [current, hasLoadedRef, pendingRouteKey])

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
            onOpenHooks={() =>
              setHooksProject(shown[0] ?? projects[0]?.slug ?? null)
            }
          />
        )}
        <TaskList
          shape={listShape}
          tasksEmpty={tasks.length === 0}
          hasProjects={projects.length > 0}
          view={view}
          filter={filter}
          setFilter={setFilter}
          showProjectLabels={showProjectLabels}
          pathBySlug={pathBySlug}
          selected={selected}
          onSelect={selectTask}
          onFocusChange={setListFocused}
          onTaskAction={onTaskAction}
          onArchiveSection={archiveSection}
        />

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
          flow={newTaskFlow}
          setFlow={setNewTaskFlow}
          newProject={newProject}
          setNewProject={setNewProject}
          height={newTaskHeight}
          setError={setError}
          refresh={refresh}
          onCreated={selectTask}
        />

        <TelemetryPanel
          // Keyed by flow name — the telemetry cache is keyed that way
          // server-side now. `agent` stays as the fallback for a payload from a
          // server that predates `flow`.
          items={telemetry[current?.flow ?? current?.agent ?? newTaskFlow] ?? []}
        />
      </div>

      <div className="detail">
        {error && <div className="error">{error}</div>}
        {hooksProject ? (
          <HooksPanel
            projects={projects}
            slug={hooksProject}
            setSlug={setHooksProject}
            onClose={() => setHooksProject(null)}
          />
        ) : current ? (
          <>
            <Conversation
              task={current}
              projectLabel={projectLabel}
              linkTask={resolveTaskLink}
              retitling={retitling}
              answering={answeringBy[taskKeyOf(current)] ?? false}
              onAtBottomChange={setAtBottom}
              onTaskAction={onTaskAction}
              saveTitle={saveTitle}
              generateTitle={generateTitle}
              allowTool={allowTool}
              setAllowEdits={setAllowEdits}
              answerAsk={answerAsk}
            />
            <ResizeHandle
              height={composerHeight}
              setHeight={setComposerHeight}
              min={96}
              reserveTop={200}
              label="Resize reply area"
            />
            <Composer
              task={current}
              height={composerHeight}
              setError={setError}
              refresh={refresh}
              replies={replies}
              setReplies={setReplies}
              sendingBy={sendingBy}
              setSendingBy={setSendingBy}
              replyFiles={replyFiles}
              setReplyFiles={setReplyFiles}
            />
          </>
        ) : (
          <div className="placeholder">Select a task</div>
        )}
      </div>
    </div>
  )
}
