import { Fragment, useEffect, useRef } from 'react'
import { CopyButton } from './copyButton'
import { useAnchoredPopup } from './hooks'
import { isUnread } from './taskMeta'
import type { TaskWithProject } from './types'

// Copies a task's id, styled to sit beside the title's sparkle and fade in with
// it on hover. It wears a link, not a clipboard: the id is how one task
// addresses another, and the clipboard now belongs to the conversation copy.
export function CopyIdButton({ id }: { id: string }) {
  return (
    <CopyButton
      text={id}
      label="Copy task ID"
      className="title-action"
      icon={
        <g
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10.5 13.5a4.5 4.5 0 0 0 6.6.4l2.6-2.6a4.5 4.5 0 0 0-6.4-6.4l-1.5 1.5" />
          <path d="M13.5 10.5a4.5 4.5 0 0 0-6.6-.4l-2.6 2.6a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5" />
        </g>
      }
    />
  )
}

// Copies the conversation as markdown — everything the reader can see, with
// collapsed stretches and closed tool details left as the summaries they show
// (see conversationMarkdown). Sits at the far right of the title row, apart
// from the controls that act on the task itself.
export function CopyConversationButton({ markdown }: { markdown: () => string }) {
  return (
    <CopyButton
      text={markdown}
      label="Copy conversation as markdown"
      className="title-action copy-conversation"
    />
  )
}

// One line of an actions menu: what it says, what it does, and whether a
// separator rules it off from the item above it.
export type MenuItem = {
  key: string
  label: React.ReactNode
  className?: string
  separatorBefore?: boolean
  onSelect: () => void
}

// The shell every actions menu wears: a trigger that opens a popup of items,
// with roving arrow-key navigation inside it. The popup is fixed-anchored to the
// trigger's live rect (see useAnchoredPopup), so neither the scrolling task list
// nor the detail header can clip it, and it flips above the trigger when there
// isn't room below. Clicks and keys are kept from bubbling, because a menu on a
// task row sits inside a row that selects on click and moves focus on arrows.
function ActionsMenu({
  className = 'task-menu',
  triggerClassName,
  triggerLabel,
  triggerTitle,
  trigger,
  items,
}: {
  className?: string
  triggerClassName: string
  // Names the trigger for assistive tech.
  triggerLabel: string
  // A hover tooltip, for a trigger whose meaning isn't already on screen. The
  // kebabs carry none: "⋮" beside a row explains itself.
  triggerTitle?: string
  trigger: React.ReactNode
  items: MenuItem[]
}) {
  const { open, setOpen, containerRef, triggerRef, popupRef, popupStyle } =
    useAnchoredPopup({ gap: 4 })
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  // Move focus into the menu once it opens, so the arrow keys (and Escape) have
  // somewhere to start.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus()
  }, [open])

  // Roving arrow-key navigation within the open menu. Each key is stopped from
  // bubbling to the row's own key handler (which would move row focus or select
  // the task); Enter/Space fall through to the focused item's click.
  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const count = items.length
    const focusAt = (i: number) =>
      itemRefs.current[((i % count) + count) % count]?.focus()
    const idx = itemRefs.current.findIndex((el) => el === document.activeElement)
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        e.stopPropagation()
        focusAt(idx + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        e.stopPropagation()
        focusAt(idx < 0 ? count - 1 : idx - 1)
        break
      case 'Home':
        e.preventDefault()
        e.stopPropagation()
        focusAt(0)
        break
      case 'End':
        e.preventDefault()
        e.stopPropagation()
        focusAt(count - 1)
        break
      case 'Enter':
      case ' ':
        e.stopPropagation()
        break
      case 'Escape':
        e.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
        break
    }
  }

  if (items.length === 0) return null

  return (
    <div className={className} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={triggerLabel}
        title={triggerTitle}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        // Keep Enter/Space (and arrows) from bubbling to the row's key handler,
        // which would otherwise select the task or move row focus.
        onKeyDown={(e) => e.stopPropagation()}
      >
        {trigger}
      </button>
      {open && (
        <div
          ref={popupRef}
          className="task-menu-popup"
          role="menu"
          style={popupStyle}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, i) => (
            <Fragment key={item.key}>
              {item.separatorBefore && i > 0 && (
                <div className="task-menu-sep" role="separator" />
              )}
              <button
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={'task-menu-item' + (item.className ? ` ${item.className}` : '')}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                  item.onSelect()
                }}
              >
                {item.label}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

// The grant-edits affordance in the detail header: a crossed-out pencil shown
// only while a task lacks edit permission (a spawner declined to forward it).
// Its lone menu item grants edits via the same UI-only PATCH the old checkbox
// used; once granted the parent stops rendering this, so the icon disappears.
export function AllowEditsMenu({ onAllowEdits }: { onAllowEdits: () => void }) {
  return (
    <ActionsMenu
      triggerClassName="title-action"
      triggerLabel="Read-only — click to allow edits"
      triggerTitle="Read-only — click to allow edits"
      trigger={
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          {/* The slash that reads the pencil as disabled/read-only. */}
          <line x1="3" y1="3" x2="21" y2="21" />
        </svg>
      }
      items={[
        { key: 'allowEdits', label: 'Allow edits', onSelect: onAllowEdits },
      ]}
    />
  )
}

// The status actions a task's kebab menu can fire, mirroring the buttons the
// detail header used to carry, plus archive/restore.
export type TaskAction =
  | 'launch'
  | 'wedge'
  | 'rest'
  | 'land'
  | 'copyId'
  | 'markUnread'
  | 'archive'
  | 'restore'

// The non-status actions that sit below a separator at the foot of the kebab
// menu. A single divider is drawn before the first of these that appears.
const FOOTER_ACTIONS = new Set<TaskAction>(['copyId', 'markUnread', 'archive'])

// The kebab (⋮) menu on a task list row. It carries the status actions that
// used to live as buttons in the detail header, plus Archive/Restore — but only
// the items that would be both *visible and enabled* for the task's current
// status, so e.g. a landed task offers Wedge/Rest/Archive but not Land. An
// archived task collapses to a single Restore.
export function TaskActionsMenu({
  task,
  onAction,
}: {
  task: TaskWithProject
  onAction: (action: TaskAction) => void
}) {
  // Build the items from the same per-status rules the header buttons encoded:
  //  - launch:  a scheduled task (scheduledFor set, resting or wedged), to run it early
  //  - wedge:   any task not already wedged
  //  - rest:    a wedged or landed task, to return it to rest
  //  - land:       any task not already landed
  //  - copyId:     any task, to copy its id to the clipboard
  //  - markUnread: any task that isn't already showing unviewed updates
  //  - archive:    any non-riding task (a riding one has a live run)
  const actions: { action: TaskAction; label: string }[] = []
  if (task.archived) {
    actions.push({ action: 'restore', label: 'Restore' })
  } else {
    if (task.scheduledFor) actions.push({ action: 'launch', label: 'Launch' })
    if (task.status !== 'wedged')
      actions.push({ action: 'wedge', label: 'Wedge' })
    if (task.status === 'wedged' || task.status === 'landed')
      actions.push({ action: 'rest', label: 'Rest' })
    if (task.status !== 'landed') actions.push({ action: 'land', label: 'Land' })
    actions.push({ action: 'copyId', label: 'Copy ID' })
    if (!isUnread(task))
      actions.push({ action: 'markUnread', label: 'Mark unread' })
    if (task.status !== 'riding')
      actions.push({ action: 'archive', label: 'Archive' })
  }

  return (
    <ActionsMenu
      triggerClassName="task-kebab"
      triggerLabel="Task actions"
      trigger="⋮"
      items={actions.map(({ action, label }, i) => ({
        key: action,
        label,
        className: `task-menu-item-${action}`,
        // Set the footer actions (Copy ID, Mark unread, Archive) apart from the
        // status actions above with a single separator before the first of them.
        separatorBefore:
          FOOTER_ACTIONS.has(action) &&
          !FOOTER_ACTIONS.has(actions[i - 1]?.action),
        onSelect: () => onAction(action),
      }))}
    />
  )
}

// The kebab on a section header (a status, or a date subheader within a split
// status). Its one action archives every task in that section at once. Shares
// the row kebab's trigger and popup styling.
export function SectionActionsMenu({
  count,
  onArchive,
}: {
  count: number
  onArchive: () => void
}) {
  return (
    <ActionsMenu
      className="task-menu section-menu"
      triggerClassName="task-kebab"
      triggerLabel="Section actions"
      trigger="⋮"
      items={[
        {
          key: 'archive',
          label: `Archive ${count} ${count === 1 ? 'task' : 'tasks'}`,
          className: 'task-menu-item-archive',
          onSelect: onArchive,
        },
      ]}
    />
  )
}
