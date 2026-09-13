import { memo, useEffect, useRef, useState } from 'react'
import { formatTimestamp } from './format'
import { GrantControl } from './grants'
import {
  AllowEditsMenu,
  CopyConversationButton,
  CopyIdButton,
  TaskActionsMenu,
} from './menus'
import { availableTaskActions } from './taskActions'
import type { TaskAction } from './taskActions'
import { taskKeyOf } from './taskRef'
import type { TaskWithProject } from './types'

// The naming sparkle, shown while haiku is picking a title for the task.
function SparkleIcon() {
  return (
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
  )
}

// The head of the open task's pane: where it lives, what it is called, the
// controls that act on it, and its status. Owns only the title's edit mode —
// everything else it renders acts through a callback. Memoized like the panes
// beside it, since App re-renders on every poll and scroll flip.
export const DetailHeader = memo(function DetailHeader({
  task,
  projectLabel,
  retitling,
  copyMarkdown,
  onTaskAction,
  saveTitle,
  generateTitle,
  allowTool,
  setAllowEdits,
}: {
  task: TaskWithProject
  // "project • worktree" for the line above the title, or null to omit it.
  projectLabel: string | null
  retitling: string | null
  // The whole conversation as markdown, built on the click rather than on every
  // render of the header.
  copyMarkdown: () => string
  onTaskAction: (task: TaskWithProject, action: TaskAction) => void
  saveTitle: (draft: string) => Promise<void>
  generateTitle: () => Promise<void>
  allowTool: (rule: string, scope: 'task' | 'project') => Promise<boolean>
  setAllowEdits: (checked: boolean) => Promise<void>
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
      {projectLabel && <div className="detail-project">{projectLabel}</div>}
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
          <button
            className="title-action"
            title="Regenerate title"
            aria-label="Regenerate title"
            disabled={retitling === taskKeyOf(task)}
            onClick={() => void generateTitle()}
          >
            <SparkleIcon />
          </button>
          <CopyIdButton id={task.id} />
          {!task.archived && (
            <GrantControl
              grants={task.grants}
              allow={task.allow}
              onAllow={allowTool}
            />
          )}
          {!task.allowEdits && !task.archived && (
            <AllowEditsMenu onAllowEdits={() => void setAllowEdits(true)} />
          )}
          <TaskActionsMenu
            actions={availableTaskActions(task)}
            onAction={(action) => onTaskAction(task, action)}
          />
          <CopyConversationButton markdown={copyMarkdown} />
        </div>
      )}
      <div className="detail-meta">
        <span
          className={
            'task-status' +
            (task.status === 'wedged' ? ' wedged' : '') +
            (task.status === 'riding' ? ' riding' : '') +
            (task.status === 'resting' ? ' resting' : '') +
            (task.status === 'landed' ? ' landed' : '')
          }
        >
          {task.status}
        </span>
        <span className="task-time">
          {formatTimestamp(task.updatedAt ?? task.createdAt)}
        </span>
      </div>
    </div>
  )
})
