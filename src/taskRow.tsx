import { forwardRef } from 'react'
import { formatTaskTime, lastPathComponent } from './format'
import { TaskActionsMenu } from './menus'
import { availableTaskActions } from './taskActions'
import type { TaskAction } from './taskActions'
import { isUnread } from './taskMeta'
import type { TaskWithProject } from './types'

// A clock face: the task has something armed to fire later.
function ClockIcon({ label }: { label: string }) {
  return (
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
      aria-label={label}
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  )
}

// A circular arrow: what's armed will fire again after it does.
function RepeatIcon() {
  return (
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
  )
}

// One task in the sidebar list: its title, where it lives, when it last moved,
// what it's waiting on, and its kebab. A listbox option — the list owns which
// row is selected, which one Tab reaches, and what the arrow keys do; the row
// only reports clicks and keys up to it.
export const TaskRow = forwardRef<
  HTMLLIElement,
  {
    task: TaskWithProject
    selected: boolean
    // Whether Tab reaches this row (the roving tabindex).
    tabbable: boolean
    // The project's path, for the leaf label; null when only one project's
    // tasks are shown and the label would be noise.
    projectPath: string | null
    // Midnight today, which decides whether the time reads as a clock or a date.
    todayStart: number
    onSelect: () => void
    onKeyDown: (e: React.KeyboardEvent<HTMLLIElement>) => void
    onAction: (action: TaskAction) => void
  }
>(function TaskRow(
  { task, selected, tabbable, projectPath, todayStart, onSelect, onKeyDown, onAction },
  ref,
) {
  const unseen = isUnread(task)
  // Any armed scheduled message — a deferred relaunch, a plain deferred send
  // (`lander send --date/--time/--await`), or a repeating relaunch — shows the
  // clock. Earlier this keyed only off relaunch-flagged messages, so a plain
  // deferred send (deliverAt/waitFor, no relaunch flag) armed no indicator at all.
  const pendingScheduled = task.scheduledMessages?.[0]
  return (
    <li
      ref={ref}
      role="option"
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      className={
        'task-item' +
        (selected ? ' selected' : '') +
        ' ' +
        task.status +
        (task.archived ? ' archived' : '') +
        (unseen ? ' unread' : '')
      }
      onClick={onSelect}
      onKeyDown={onKeyDown}
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
          {projectPath !== null && (
            <span className="task-project">{lastPathComponent(projectPath)}</span>
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
            <ClockIcon
              label={
                task.scheduledFor || pendingScheduled?.deliverAt
                  ? 'Scheduled'
                  : 'Awaiting'
              }
            />
          )}
          {task.scheduledMessages?.some((m) => m.repeat) && <RepeatIcon />}
          {task.status === 'riding' && (
            <span className="riding-spinner" aria-label="Riding" />
          )}
        </div>
      </div>
      <TaskActionsMenu actions={availableTaskActions(task)} onAction={onAction} />
    </li>
  )
})
