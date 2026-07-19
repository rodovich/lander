import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Composer } from './composer'
import { Conversation } from './conversation'
import { dataTransferHasFiles } from './fileDrop'
import { lastPathComponent, taskIdFromPath, worktreeName } from './format'
import { usePersistentState, useSessionState } from './hooks'
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
    selectedTaskId && tasks.some((t) => t.id === selectedTaskId)
      ? selectedTaskId
      : orderedTasks[0]?.id ?? null
  const current = tasks.find((t) => t.id === selected) ?? null
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
    setSelectedTaskId(id)
    window.history.pushState(null, '', `/${projectSlug}/${id}`)
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
      else if (action === 'markUnread') void markUnread(task.id)
      else if (action === 'archive') void archiveTask(task, true)
      else if (action === 'restore') void archiveTask(task, false)
    },
    [launchNow, setStatus, markUnread, archiveTask],
  )

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
        {current ? (
          <>
            <Conversation
              task={current}
              projectLabel={projectLabel}
              linkTask={resolveTaskLink}
              retitling={retitling}
              answering={answeringBy[current.id] ?? false}
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
            />
          </>
        ) : (
          <div className="placeholder">Select a task</div>
        )}
      </div>
    </div>
  )
}
