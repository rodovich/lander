import { memo, useEffect, useRef, useState } from 'react'
import { AppRow } from './appRow'
import { CheckoutChip } from './checkoutChip'
import { formatTimestamp } from './format'
import { GrantControl } from './grants'
import { IconButton } from './iconButton'
import { CopyConversationButton, CopyIdButton, TaskActionsMenu } from './menus'
import { availableTaskActions } from './taskActions'
import type { TaskAction } from './taskActions'
import { taskHref, taskKeyOf } from './taskRef'
import { SubtasksChip } from './subtasks'
import { TaskChip, TaskStatus } from './timelineNote'
import type { FlowCaps, TaskWithProject } from './types'

function SparkleIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 1.5l1.4 3.6 3.6 1.4-3.6 1.4L7 11.5 5.6 7.9 2 6.5l3.6-1.4z" />
      <path d="M12 9.5l.75 1.75 1.75.75-1.75.75L12 14.5l-.75-1.75L9.5 12l1.75-.75z" />
    </svg>
  )
}

// The head of the open task's pane: where it lives, what it is called, the
// controls that act on it, and its status. Owns only the title's edit mode —
// everything else it renders acts through a callback. Memoized like the panes
// beside it, since App re-renders on every poll and scroll flip.
export const DetailHeader = memo(function DetailHeader({
  task,
  grants,
  retitling,
  copyMarkdown,
  onTaskAction,
  saveTitle,
  generateTitle,
  allowTool,
  onRetry,
  subtasks,
  parent,
  todayStart,
  onOpenTask,
}: {
  task: TaskWithProject
  // The tasks this one launched to manage, in list order, and the task that
  // launched this one to manage it.
  subtasks?: TaskWithProject[]
  parent?: TaskWithProject
  todayStart: number
  onOpenTask: (id: string, projectSlug: string) => void
  // What the task's flow lets the grant control offer.
  grants: FlowCaps['grants']
  retitling: string | null
  // The whole conversation as markdown, built on the click rather than on every
  // render of the header.
  copyMarkdown: () => string
  onTaskAction: (task: TaskWithProject, action: TaskAction) => void
  saveTitle: (draft: string) => Promise<void>
  generateTitle: () => Promise<void>
  allowTool: (rule: string, scope: 'task' | 'project') => Promise<boolean>
  onRetry: () => Promise<boolean>
}) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Leave edit mode when the task switches, so a half-typed title can't follow
  // the reader to the next task.
  useEffect(() => {
    setEditingTitle(false)
  }, [task.id, task.projectSlug])

  // Focus and select the title when entering edit mode.
  useEffect(() => {
    if (editingTitle) {
      const el = titleInputRef.current
      el?.focus()
      el?.select()
    }
  }, [editingTitle])

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

  return (
    <div className="detail-header">
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
            onClick={() => {
              setTitleDraft(task.title)
              setEditingTitle(true)
            }}
          >
            {task.title}
          </h1>
          <IconButton
            label="Regenerate title"
            disabled={retitling === taskKeyOf(task)}
            onClick={() => void generateTitle()}
          >
            <SparkleIcon />
          </IconButton>
          <CopyIdButton id={task.id} />
          {!task.archived && (
            <GrantControl
              key={taskKeyOf(task)}
              grants={grants}
              allow={task.allow}
              onAllow={allowTool}
              onRetry={task.status === 'wedged' || task.status === 'paced' ? onRetry : undefined}
            />
          )}
          <TaskActionsMenu
            actions={availableTaskActions(task)}
            onAction={(action) => onTaskAction(task, action)}
          />
          <CopyConversationButton markdown={copyMarkdown} />
        </div>
      )}
      {task.checkout && <CheckoutChip checkout={task.checkout} />}
      {!task.archived && task.status !== 'landed' && (
        <AppRow key={taskKeyOf(task)} slug={task.projectSlug} taskId={task.id} />
      )}
      <div className="detail-meta">
        <TaskStatus status={task.status} />
        <SubtasksChip subtasks={subtasks} todayStart={todayStart} onOpen={onOpenTask} />
        <span className="task-time">
          {formatTimestamp(task.updatedAt ?? task.createdAt)}
        </span>
        {parent && (
          <span className="task-parent">
            in{' '}
            <TaskChip
              href={taskHref(parent.projectSlug, parent.id)}
              title={parent.title}
              status={parent.status}
            />
          </span>
        )}
      </div>
    </div>
  )
})
