import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Composer } from './composer'
import { Conversation, type ConversationReveal } from './conversation'
import { conversationMarkdown } from './conversationMarkdown'
import { DetailHeader } from './detailHeader'
import { dataTransferHasFiles } from './fileDrop'
import { usePersistentState, useSessionState } from './hooks'
import { HooksPanel } from './hooksPanel'
import { DEFAULT_TIME_FILTER, DEFAULT_VIEW, lastPathComponent } from './format'
import { Navbar, pageTitle, type Panel } from './navbar'
import { NewTaskForm } from './newTaskForm'
import { tick } from './perf'
import { ResizeHandle } from './resizeHandle'
import { StatsPanel } from './statsPanel'
import { TaskList } from './taskList'
import { TaskLinkProvider } from './taskLinkContext'
import { buildTaskRows } from './taskRows'
import { TelemetryPanel } from './telemetry'
import type { ConversationMatch } from '../shared/conversationSearch'
import { buildTimeline } from '../shared/timeline'
import { useReadMarker, useViewingState } from './useReadMarker'
import { useTaskActions } from './useTaskActions'
import { useTaskData } from './useTaskData'
import { useReplyDrafts } from './useReplyDrafts'
import { useTaskRouting } from './useTaskRouting'
import { useTimelineDisclosure } from './useTimelineDisclosure'
import {
  taskKeyOf,
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
  const [view, setView] = useSessionState<TaskView>('lander:view', DEFAULT_VIEW)
  // The list's time-window filter (see TimeFilter), session-scoped alongside view.
  const [timeFilter, setTimeFilter] = useSessionState<TimeFilter>(
    'lander:timeFilter',
    DEFAULT_TIME_FILTER,
  )
  // What an action failed with — a land the daemon refused, a message that
  // didn't send. Sticky on purpose: it reports something the user did, and it
  // stays until they do the next thing.
  const [error, setError] = useState<string | null>(null)
  // What the tasks poll last failed with, owned by the poll and cleared by its
  // next good cycle (see useTaskData). Kept out of `error` rather than sharing
  // it: a self-clearing slot would wipe an action's message within the 2s poll
  // gap, which is faster than it can be read.
  const [pollError, setPollError] = useState<string | null>(null)
  const initialTaskRef = useRef<TaskRef | null>(taskRefFromPath())
  // The list search box, session-scoped alongside the other list filters.
  const [filter, setFilter] = useSessionState('lander:filter', '')
  const query = filter.trim().toLowerCase()
  // The task data proper: the displayed list and its polls, the open task's
  // conversation, the server's search, per-flow telemetry, projects and the
  // session's open project, and mention-link resolution.
  const {
    tasks,
    tasksRef,
    telemetry,
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
  } = useTaskData(view, setPollError, initialTaskRef.current?.projectSlug, query)
  // The open task, readable by the actions at call time. Assigned below, once
  // the effective selection is derived from the shaped list.
  const currentRef = useRef<TaskWithProject | null>(null)
  const {
    markSeen,
    runTaskAction,
    archiveSection,
    allowTool,
    tryAgain,
    saveTitle,
    generateTitle,
    retitling,
    answerAsk,
    answeringBy,
  } = useTaskActions({
    currentRef,
    tasksRef,
    refresh,
    beginTaskMutation,
    finishTaskMutation,
    beginTaskRemoval,
    finishTaskRemoval,
    setError,
  })
  // Which navbar panel (stats, or the open project's hook settings) fills the
  // detail pane in place of the conversation, if any. Not persisted: it is a
  // place you go, not a mode the app should still be in tomorrow.
  const [panel, setPanel] = useState<Panel | null>(null)

  // The new-task form's agent pick. Session-scoped like the form's draft
  // message (which lives in the form), so two tabs keep independent picks.
  // Lifted here rather than owned by the form because App reads it for the
  // telemetry panel.
  const [newTaskFlow, setNewTaskFlow] = useSessionState<string>(
    'lander:draft:newFlow',
    'claude',
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

  // The ambient viewing signals (tab focus, how far the open conversation is
  // read, list focus) and the sticky-unread set the Unread view's filter
  // consumes.
  const { readUpTo, setReadUpTo, tabActive, setListFocused, stickyUnread } =
    useViewingState(view, tasks)

  const pathBySlug = useMemo(
    () => new Map(projects.map((p) => [p.slug, p.path])),
    [projects],
  )

  // Shape the sidebar list from the raw tasks and the active filters (see
  // taskRows.ts). Keyed on the poll-refreshed tasks array (a fresh identity
  // every 2s), so the time bucketing still tracks the wall clock while
  // unrelated renders — scroll flips, menu state — reuse the shape and let the
  // memoized TaskList hold still.
  const listShape = useMemo(
    () =>
      buildTaskRows(tasks, {
        view,
        timeFilter,
        query,
        matches: search?.matches ?? null,
        stickyUnread,
        now: new Date(),
      }),
    [tasks, view, timeFilter, query, search, stickyUnread],
  )
  const { orderedTasks } = listShape

  // Picking a task, or following a link or the back button to one, is how you
  // leave a navbar panel; it shares the pane.
  const leavePanel = useCallback(() => setPanel(null), [])
  const togglePanel = useCallback(
    (name: Panel) => setPanel((open) => (open === name ? null : name)),
    [],
  )
  const { selected, current, selectTask } = useTaskRouting({
    initialRef: initialTaskRef.current,
    tasks,
    orderedTasks,
    taskLinks,
    taskLinksLoaded,
    hasLoadedRef,
    setProject,
    setView,
    onNavigate: leavePanel,
  })
  currentRef.current = current
  useEffect(() => {
    watchTask(current)
  }, [current, watchTask])

  // The search match last opened from the list, which the conversation brings
  // into view while that task stays open and the query stands.
  const [openedMatch, setOpenedMatch] = useState<{
    key: string
    reveal: ConversationReveal
  } | null>(null)
  const openMatch = useCallback(
    (task: TaskWithProject, match: ConversationMatch) => {
      // The query the match was found under. It can trail the search box, and
      // then the reveal below doesn't apply: the match's occurrence counts that
      // query's hits, not the box's.
      const foundUnder = search?.query ?? query
      setOpenedMatch({
        key: taskKeyOf(task),
        reveal: {
          itemId: match.itemId,
          occurrence: match.occurrence,
          query: foundUnder,
        },
      })
      selectTask(task.id, task.projectSlug)
    },
    [search, query, selectTask],
  )
  const reveal =
    openedMatch &&
    current &&
    openedMatch.key === taskKeyOf(current) &&
    openedMatch.reveal.query === query
      ? openedMatch.reveal
      : null

  // Advance the open task's read marker over whatever has stayed read for the
  // dwell.
  useReadMarker({ current, readUpTo, tabActive, markSeen })

  // What the reader has opened on the open task's timeline, shared by the
  // timeline that draws it and the header's copy, which writes out what's showing.
  const disclosure = useTimelineDisclosure(current)
  const clearFilter = useCallback(() => setFilter(''), [setFilter])
  const onTaskCreated = useCallback(
    (id: string, slug: string) => {
      clearFilter()
      selectTask(id, slug)
    },
    [clearFilter, selectTask],
  )
  // The open task's reply in progress; every task's draft is kept above the
  // composer, which unmounts when no task is open.
  const draft = useReplyDrafts(current, {
    setError,
    onSent: clearFilter,
    refresh,
    taskLinks,
    taskLinksLoaded,
  })
  // Built on the click, not per render: the whole document is work, and a
  // fresh `now` places any in-flight turn where it stands at that moment.
  const copyMarkdown = useCallback(
    () =>
      current
        ? conversationMarkdown({
            task: current,
            timeline: buildTimeline(current, new Date().toISOString()).items,
            openDetails: disclosure.openDetails,
            expandedTurns: disclosure.expandedTurns,
          })
        : '',
    [current, disclosure],
  )

  // Keep the page title naming the open project and any non-default filters.
  const title = pageTitle(pathBySlug.get(project), timeFilter, view)
  useEffect(() => {
    document.title = title
  }, [title])

  return (
    <>
      <Navbar
        projects={projects}
        project={project}
        setProject={setProject}
        panel={panel}
        onTogglePanel={togglePanel}
        // One slot for both errors. An action's failure wins it while it is
        // up: the user is standing in front of it, and the poll's is the
        // ambient one.
        error={error ?? pollError}
      />
      <div className="layout">
        <div className="sidebar">
          <TaskList
            shape={listShape}
            tasksEmpty={tasks.length === 0}
            hasProjects={projects.length > 0}
            view={view}
            setView={setView}
            timeFilter={timeFilter}
            setTimeFilter={setTimeFilter}
            filter={filter}
            setFilter={setFilter}
            selected={selected}
            onSelect={selectTask}
            onFocusChange={setListFocused}
            onTaskAction={runTaskAction}
            onArchiveSection={archiveSection}
            onOpenMatch={openMatch}
            onRequestMatches={requestMatches}
          />

          <ResizeHandle
            height={newTaskHeight}
            setHeight={setNewTaskHeight}
            min={150}
            reserveTop={160}
            label="Resize new task area"
          />
          <NewTaskForm
            targetSlug={project}
            flow={newTaskFlow}
            setFlow={setNewTaskFlow}
            height={newTaskHeight}
            setError={setError}
            admit={admitTask}
            onCreated={onTaskCreated}
          />

          <TelemetryPanel
            // Keyed by flow name — the telemetry cache is keyed that way
            // server-side now. `agent` stays as the fallback for a payload from
            // a server that predates `flow`.
            items={telemetry[current?.flow ?? current?.agent ?? newTaskFlow] ?? []}
          />
        </div>

        <div className="detail">
          {panel === 'stats' && project ? (
            <StatsPanel
              slug={project}
              projectName={lastPathComponent(pathBySlug.get(project) ?? project)}
              onClose={leavePanel}
            />
          ) : panel === 'hooks' && project ? (
            <HooksPanel slug={project} onClose={leavePanel} />
          ) : current ? (
            <TaskLinkProvider value={resolveTaskLink}>
              <DetailHeader
                task={current}
                retitling={retitling}
                copyMarkdown={copyMarkdown}
                onTaskAction={runTaskAction}
                saveTitle={saveTitle}
                generateTitle={generateTitle}
                allowTool={allowTool}
                onRetry={tryAgain}
              />
              <Conversation
                task={current}
                disclosure={disclosure}
                reveal={reveal}
                answering={answeringBy[taskKeyOf(current)] ?? false}
                onReadUpTo={setReadUpTo}
                allowTool={allowTool}
                answerAsk={answerAsk}
                onTaskAction={runTaskAction}
                onRetry={tryAgain}
              />
              <ResizeHandle
                height={composerHeight}
                setHeight={setComposerHeight}
                min={96}
                reserveTop={200}
                label="Resize reply area"
              />
              {draft && (
                <Composer task={current} height={composerHeight} draft={draft} />
              )}
            </TaskLinkProvider>
          ) : (
            <div className="placeholder">Select a task</div>
          )}
        </div>
      </div>
    </>
  )
}
