import { Fragment, memo, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import {
  DATE_CATEGORY_LABELS,
  DEFAULT_TIME_FILTER,
  DEFAULT_VIEW,
  TIME_FILTER_LABELS,
  VIEW_LABELS,
} from './format'
import { HighlightedText } from './highlightedText'
import { ListSubrow } from './listSubrow'
import { FilterMenu, SectionActionsMenu } from './menus'
import type { TaskAction } from './taskActions'
import { tick } from './perf'
import { taskKeyOf } from './taskRef'
import { TaskRow } from './taskRow'
import type { TaskListShape, TaskRow as ListRow } from './taskRows'
import type { ConversationMatch } from './taskSearch'
import type { TaskView, TaskWithProject, TimeFilter } from './types'

const TASK_VIEWS: TaskView[] = ['inbox', 'unread', 'archived']
const TIME_FILTERS: TimeFilter[] = ['today', 'week', 'older', 'any']

// How many of a task's search matches show under it at first, and how many
// more each "Show N more" adds.
const MATCHES_SHOWN = 3
const MATCHES_MORE = 20

// A sticky header over a run of tasks: a status, or a date bucket within a
// status split into dates. Faint rules bracket each contiguous run of task rows
// around the headers. The header→tasks rule (rule-below) rides on the header so
// it pins with it in sticky mode. The tasks→header rule rides in the flow just
// above the header as its own <li>, so it scrolls up and out of view as the
// header pins (no separator between stacked sticky headers) and keeps clear of
// the header text below it.
function SectionHeader({
  row,
  ruleAbove,
  ruleBelow,
  archivable,
  onArchiveSection,
  anchorRef,
}: {
  row: Exclude<ListRow, { kind: 'task' }>
  ruleAbove: boolean
  ruleBelow: boolean
  // False in the archived view, which is already the archive.
  archivable: boolean
  onArchiveSection: (targets: TaskWithProject[]) => void
  // A status header's scroll anchor, for the count chips (see TaskList).
  anchorRef: (el: HTMLLIElement | null) => void
}) {
  const split = row.kind === 'status' && row.split
  // The archive menu rides the leaf header — a date subheader, or a status
  // that isn't broken out into dates — and archives just the tasks under it. A
  // riding task has a live run the server won't archive, so that section gets
  // none.
  const menu = archivable && !split && row.status !== 'riding'
  return (
    <>
      {row.kind === 'status' && (
        <li
          ref={anchorRef}
          className={'task-section-anchor' + (row.first ? ' first' : '')}
          role="presentation"
          aria-hidden="true"
        />
      )}
      {ruleAbove && (
        <li className="task-rule" role="presentation" aria-hidden="true" />
      )}
      <li
        role="presentation"
        className={
          `task-group-header ${row.kind} ${row.status}` +
          (row.first ? ' first' : '') +
          (split ? ' split' : '') +
          (ruleBelow ? ' rule-below' : '')
        }
      >
        <span className="task-group-label">
          {row.kind === 'status' ? row.status : DATE_CATEGORY_LABELS[row.category]}
        </span>
        {menu && (
          <SectionActionsMenu
            count={row.tasks.length}
            onArchive={() => onArchiveSection(row.tasks)}
          />
        )}
      </li>
    </>
  )
}

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
  setView,
  timeFilter,
  setTimeFilter,
  filter,
  setFilter,
  selected,
  onSelect,
  onFocusChange,
  onTaskAction,
  onArchiveSection,
  onOpenMatch,
}: {
  shape: TaskListShape
  // Whether the unfiltered task list is empty (distinguishes "No tasks yet"
  // from "No matching tasks").
  tasksEmpty: boolean
  hasProjects: boolean
  view: TaskView
  setView: Dispatch<SetStateAction<TaskView>>
  timeFilter: TimeFilter
  setTimeFilter: Dispatch<SetStateAction<TimeFilter>>
  filter: string
  setFilter: Dispatch<SetStateAction<string>>
  selected: string | null
  onSelect: (id: string, projectSlug: string) => void
  // Whether DOM focus rests on a row inside the list (see useViewingState).
  onFocusChange: (focused: boolean) => void
  onTaskAction: (task: TaskWithProject, action: TaskAction) => void
  onArchiveSection: (targets: TaskWithProject[]) => void
  // Opens a task at one of its search matches.
  onOpenMatch: (task: TaskWithProject, match: ConversationMatch) => void
}) {
  // Opt-in profiling (see perf.ts): count re-renders of the list pane
  // separately from App's own churn.
  tick('TaskList.render')
  const { orderedTasks, taskRows, statusCounts, todayStart, query } = shape

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
  // Tab, and arrow keys move DOM focus through the stops — every task row and,
  // while searching, the match rows under it — in list order. Stops are
  // numbered during render.
  const stopRefs = useRef<(HTMLLIElement | null)[]>([])
  const stopCountRef = useRef(0)
  // A stop to focus once the next render lands: where "Show N more" stood,
  // which the first of the newly shown matches takes over.
  const pendingFocusRef = useRef<number | null>(null)
  useEffect(() => {
    if (pendingFocusRef.current == null) return
    stopRefs.current[pendingFocusRef.current]?.focus()
    pendingFocusRef.current = null
  })
  const taskListRef = useRef<HTMLUListElement>(null)

  // How many matches each task shows, by task key, for the query they were
  // shown under — a new query starts every task back at the default.
  const [matchLimits, setMatchLimits] = useState<{
    query: string
    byTask: Map<string, number>
  }>({ query: '', byTask: new Map() })
  const matchLimit = (key: string) =>
    (matchLimits.query === query ? matchLimits.byTask.get(key) : undefined) ??
    MATCHES_SHOWN
  function showMoreMatches(key: string, stop: number) {
    const byTask = new Map(matchLimits.query === query ? matchLimits.byTask : [])
    byTask.set(key, matchLimit(key) + MATCHES_MORE)
    setMatchLimits({ query, byTask })
    pendingFocusRef.current = stop
  }
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

  function focusStop(stop: number) {
    const clamped = Math.max(0, Math.min(stopCountRef.current - 1, stop))
    stopRefs.current[clamped]?.focus()
  }

  function onStopKeyDown(
    e: React.KeyboardEvent<HTMLLIElement>,
    stop: number,
    activate: () => void,
  ) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusStop(stop + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        focusStop(stop - 1)
        break
      case 'Home':
        e.preventDefault()
        focusStop(0)
        break
      case 'End':
        e.preventDefault()
        focusStop(stopCountRef.current - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        activate()
        break
    }
  }

  // Numbered as the rows render below; the effect reads the final count.
  let stops = 0
  useEffect(() => {
    stopCountRef.current = stops
    stopRefs.current.length = stops
  })

  return (
    <>
      <div className="task-toolbar">
        <input
          ref={searchInputRef}
          type="search"
          className="task-search"
          placeholder="Search tasks (⌘⇧F)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="task-filters">
          <FilterMenu
            label="View"
            value={view}
            defaultValue={DEFAULT_VIEW}
            onChange={setView}
            options={TASK_VIEWS.map((v) => ({ value: v, label: VIEW_LABELS[v] }))}
          />
          <FilterMenu
            label="Time"
            value={timeFilter}
            defaultValue={DEFAULT_TIME_FILTER}
            onChange={setTimeFilter}
            options={TIME_FILTERS.map((t) => ({
              value: t,
              label: TIME_FILTER_LABELS[t],
            }))}
          />
        </div>
      </div>
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
          if (row.kind !== 'task') {
            return (
              <SectionHeader
                key={row.key}
                row={row}
                ruleAbove={prevIsTask}
                ruleBelow={nextIsTask}
                archivable={view !== 'archived'}
                onArchiveSection={onArchiveSection}
                anchorRef={(el) => {
                  if (el) sectionAnchorRefs.current.set(row.status, el)
                  else sectionAnchorRefs.current.delete(row.status)
                }}
              />
            )
          }
          const { task, index, matches } = row
          const select = () => onSelect(task.id, task.projectSlug)
          const stop = stops++
          // While searching, the task's conversation matches follow it as
          // subrows: the first few, then a link to show more.
          const shown = matches?.list(matchLimit(row.key)) ?? []
          const more = matches
            ? Math.min(matches.count - shown.length, MATCHES_MORE)
            : 0
          return (
            <Fragment key={row.key}>
              <TaskRow
                ref={(el) => {
                  stopRefs.current[stop] = el
                }}
                task={task}
                selected={taskKeyOf(task) === selected}
                tabbable={index === rovingIndex}
                todayStart={todayStart}
                query={query}
                onSelect={select}
                onKeyDown={(e) => onStopKeyDown(e, stop, select)}
                onAction={(action) => onTaskAction(task, action)}
              />
              {shown.map((match, mi) => {
                const matchStop = stops++
                const open = () => onOpenMatch(task, match)
                return (
                  <ListSubrow
                    key={mi}
                    ref={(el) => {
                      stopRefs.current[matchStop] = el
                    }}
                    onClick={open}
                    onKeyDown={(e) => onStopKeyDown(e, matchStop, open)}
                  >
                    <HighlightedText text={match.snippet} query={query} />
                  </ListSubrow>
                )
              })}
              {more > 0 &&
                (() => {
                  const moreStop = stops++
                  const showMore = () => showMoreMatches(row.key, moreStop)
                  return (
                    <ListSubrow
                      link
                      ref={(el) => {
                        stopRefs.current[moreStop] = el
                      }}
                      onClick={showMore}
                      onKeyDown={(e) => onStopKeyDown(e, moreStop, showMore)}
                    >
                      Show {more} more
                    </ListSubrow>
                  )
                })()}
              {shown.length > 0 && (
                <li
                  className="list-subrow-end"
                  role="presentation"
                  aria-hidden="true"
                />
              )}
            </Fragment>
          )
        })}
      </ul>
    </>
  )
})
