import { Fragment, useEffect, useRef, useState } from 'react'
import { isUnread } from './taskMeta'
import type { TaskWithProject } from './types'

// A clipboard button for copying a task's id, styled to sit beside the
// title's sparkle and fade in with it on hover. Flips to a checkmark after a
// successful copy so the click registers.
export function CopyIdButton({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied (e.g. insecure context); ignore.
    }
  }
  return (
    <button
      type="button"
      className="edit-title-button"
      onClick={copy}
      title="Copy task ID"
      aria-label={copied ? 'Copied' : 'Copy task ID'}
    >
      {copied ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M20 6 9 17l-5-5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect
            x="9"
            y="9"
            width="11"
            height="11"
            rx="2"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M5 15V5a2 2 0 0 1 2-2h10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  )
}

// The read-only affordance in the detail header: a crossed-out pencil shown
// only while a task lacks edit permission (a spawner declined to forward it).
// Its lone menu item grants edits via the same UI-only PATCH the old checkbox
// used; once granted the parent stops rendering this, so the icon disappears.
// Mirrors TaskActionsMenu's fixed-anchor popup so the header can't clip it.
export function ReadOnlyMenu({ onAllowEdits }: { onAllowEdits: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const itemRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  )

  useEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect()
      if (r) setAnchor({ top: r.bottom + 4, left: r.left })
    }
    place()
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Focus the lone item once the popup is placed, so Enter/Escape land somewhere.
  useEffect(() => {
    if (open && anchor) itemRef.current?.focus()
  }, [open, anchor])

  return (
    <div className="task-menu" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className="edit-title-button"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Read-only — click to allow edits"
        aria-label="Read-only — click to allow edits"
        onClick={() => setOpen((o) => !o)}
      >
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
      </button>
      {open && anchor && (
        <div
          className="task-menu-popup"
          role="menu"
          style={{ top: anchor.top, left: anchor.left }}
        >
          <button
            ref={itemRef}
            type="button"
            role="menuitem"
            className="task-menu-item"
            onClick={() => {
              setOpen(false)
              onAllowEdits()
            }}
          >
            Allow edits
          </button>
        </div>
      )}
    </div>
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
// archived task collapses to a single Restore. The button stops click
// propagation so opening the menu doesn't also select the row, and the menu is
// fixed-positioned (anchored to the button's live rect, re-measured on
// scroll/resize) so the scrolling task list can't clip it.
export function TaskActionsMenu({
  task,
  onAction,
}: {
  task: TaskWithProject
  onAction: (action: TaskAction) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  )

  // Build the items from the same per-status rules the header buttons encoded:
  //  - launch:  a scheduled task (scheduledFor set, resting or wedged), to run it early
  //  - wedge:   any task not already wedged
  //  - rest:    a wedged or landed task, to return it to rest
  //  - land:       any task not already landed
  //  - copyId:     any task, to copy its id to the clipboard
  //  - markUnread: any task that isn't already showing unviewed updates
  //  - archive:    any non-riding task (a riding one has a live run)
  const items: { action: TaskAction; label: string }[] = []
  if (task.archived) {
    items.push({ action: 'restore', label: 'Restore' })
  } else {
    if (task.scheduledFor) items.push({ action: 'launch', label: 'Launch' })
    if (task.status !== 'wedged') items.push({ action: 'wedge', label: 'Wedge' })
    if (task.status === 'wedged' || task.status === 'landed')
      items.push({ action: 'rest', label: 'Rest' })
    if (task.status !== 'landed') items.push({ action: 'land', label: 'Land' })
    items.push({ action: 'copyId', label: 'Copy ID' })
    if (!isUnread(task))
      items.push({ action: 'markUnread', label: 'Mark unread' })
    if (task.status !== 'riding')
      items.push({ action: 'archive', label: 'Archive' })
  }

  useEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect()
      if (r) setAnchor({ top: r.bottom + 4, left: r.left })
    }
    place()
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Move focus into the menu once it's mounted (anchor placed), so the arrow
  // keys have somewhere to start.
  useEffect(() => {
    if (open && anchor) itemRefs.current[0]?.focus()
  }, [open, anchor])

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
        buttonRef.current?.focus()
        break
    }
  }

  if (items.length === 0) return null

  return (
    <div className="task-menu" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className="task-kebab"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Task actions"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        // Keep Enter/Space (and arrows) from bubbling to the row's key handler,
        // which would otherwise select the task or move row focus.
        onKeyDown={(e) => e.stopPropagation()}
      >
        ⋮
      </button>
      {open && anchor && (
        <div
          className="task-menu-popup"
          role="menu"
          style={{ top: anchor.top, left: anchor.left }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((it, i) => (
            <Fragment key={it.action}>
              {/* Set the footer actions (Copy ID, Mark unread, Archive) apart
                  from the status actions above with a single separator before
                  the first of them. */}
              {i > 0 &&
                FOOTER_ACTIONS.has(it.action) &&
                !FOOTER_ACTIONS.has(items[i - 1].action) && (
                  <div className="task-menu-sep" role="separator" />
                )}
              <button
                ref={(el) => {
                  itemRefs.current[i] = el
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`task-menu-item task-menu-item-${it.action}`}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpen(false)
                  onAction(it.action)
                }}
              >
                {it.label}
              </button>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

// The kebab on a section header (a status, or a date subheader within a split
// status). Its one action archives every task in that section at once. Shares the
// row kebab's trigger and popup styling, opening the popup down and to the right
// from the trigger like the task menu; with a single item it skips the roving
// navigation.
export function SectionActionsMenu({
  count,
  onArchive,
}: {
  count: number
  onArchive: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const itemRef = useRef<HTMLButtonElement>(null)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(
    null,
  )

  useEffect(() => {
    if (!open) {
      setAnchor(null)
      return
    }
    const place = () => {
      const r = buttonRef.current?.getBoundingClientRect()
      if (r) setAnchor({ top: r.bottom + 4, left: r.left })
    }
    place()
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Focus the single item once the popup is placed, so Escape/Enter land on it.
  useEffect(() => {
    if (open && anchor) itemRef.current?.focus()
  }, [open, anchor])

  return (
    <div className="task-menu section-menu" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className="task-kebab"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Section actions"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        ⋮
      </button>
      {open && anchor && (
        <div
          className="task-menu-popup"
          role="menu"
          style={{ top: anchor.top, left: anchor.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            ref={itemRef}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="task-menu-item task-menu-item-archive"
            onClick={(e) => {
              e.stopPropagation()
              setOpen(false)
              onArchive()
            }}
          >
            Archive {count} {count === 1 ? 'task' : 'tasks'}
          </button>
        </div>
      )}
    </div>
  )
}
