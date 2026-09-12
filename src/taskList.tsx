import { Fragment, memo, useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { DATE_CATEGORY_LABELS, dateCategory } from './format'
import { SectionActionsMenu } from './menus'
import type { TaskAction } from './taskActions'
import { tick } from './perf'
import { taskKeyOf } from './taskRef'
import { TaskRow } from './taskRow'
import type { TaskListShape } from './taskRows'
import type { DateCategory, TaskView, TaskWithProject } from './types'

// The sidebar's task list: the toolbar (status-count chips, search), the rows
// with their sticky status/date headers, section scroll anchors, and the
// roving-tabindex keyboard navigation. Renders the shape buildTaskRows
// derived; owns only DOM concerns (refs, focus, scrolling). Memoized: the
// shape is useMemo'd upstream, so scroll flips and other unrelated App state
// leave this pane still.
export const TaskList = memo(function TaskList({
  shape,
  tasksEmpty,
  hasProjects,
  view,
  filter,
  setFilter,
  showProjectLabels,
  pathBySlug,
  selected,
  onSelect,
  onFocusChange,
  onTaskAction,
  onArchiveSection,
}: {
  shape: TaskListShape
  // Whether the unfiltered task list is empty (distinguishes "No tasks yet"
  // from "No matching tasks").
  tasksEmpty: boolean
  hasProjects: boolean
  view: TaskView
  filter: string
  setFilter: Dispatch<SetStateAction<string>>
  showProjectLabels: boolean
  pathBySlug: Map<string, string>
  selected: string | null
  onSelect: (id: string, projectSlug: string) => void
  // Whether DOM focus rests on a row inside the list (see useViewingState).
  onFocusChange: (focused: boolean) => void
  onTaskAction: (task: TaskWithProject, action: TaskAction) => void
  onArchiveSection: (targets: TaskWithProject[]) => void
}) {
  // Opt-in profiling (see perf.ts): count re-renders of the list pane
  // separately from App's own churn.
  tick('TaskList.render')
  const {
    orderedTasks,
    taskRows,
    statusCounts,
    countByStatus,
    countByStatusDate,
    dateCatsByStatus,
    todayStart,
    weekStart,
  } = shape

  const searchInputRef = useRef<HTMLInputElement>(null)

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

  // Roving-tabindex bookkeeping: the selected row is the one reachable with
  // Tab, and arrow keys move DOM focus between rows.
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
  const selectedIndex = orderedTasks.findIndex((t) => taskKeyOf(t) === selected)
  const rovingIndex = selectedIndex >= 0 ? selectedIndex : 0

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
        onSelect(task.id, task.projectSlug)
        break
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

  return (
    <>
      <div className="task-toolbar">
        {hasProjects && statusCounts.length > 0 && (
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
        onFocus={() => onFocusChange(true)}
        onBlur={(e) => {
          // focusout bubbles, so this fires when focus hops between rows too;
          // only count it as leaving when the new target is outside the list
          // (a text field, another pane, or — with a null target — the window).
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            onFocusChange(false)
        }}
      >
        {tasksEmpty && (
          <li className="empty" role="presentation">No tasks yet</li>
        )}
        {!tasksEmpty && orderedTasks.length === 0 && (
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
                          onArchiveSection(sectionTargets(row.status))
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
                        onArchiveSection(
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
          return (
            <TaskRow
              key={row.key}
              ref={(el) => {
                taskItemRefs.current[index] = el
              }}
              task={task}
              selected={taskKeyOf(task) === selected}
              tabbable={index === rovingIndex}
              projectPath={
                showProjectLabels
                  ? (pathBySlug.get(task.projectSlug) ?? task.projectSlug)
                  : null
              }
              todayStart={todayStart}
              onSelect={() => onSelect(task.id, task.projectSlug)}
              onKeyDown={(e) => onTaskKeyDown(e, index, task)}
              onAction={(action) => onTaskAction(task, action)}
            />
          )
        })}
      </ul>
    </>
  )
})
