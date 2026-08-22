import { useState, type ReactNode } from 'react'
import { formatTimestamp } from './format'
import { taskHref } from './taskRef'
import { Collapsible } from './toolStep'

// The statuses that have a tint of their own. Anything else — a status this
// client doesn't know, or one carrying whitespace that would inject a second
// class — renders untinted rather than as a broken selector.
const TINTED = new Set(['riding', 'resting', 'wedged', 'landed'])

// The variant token a status contributes to a className, or nothing.
export function statusClass(status: string | undefined): string {
  return status && TINTED.has(status) ? ` ${status}` : ''
}

// A link to another task, tinted by that task's current status: the chip worn
// by an awaited task on a lifecycle event and by the subject of a task action
// alike. The caller resolves the title, because which one is right differs —
// an event names the task as it was, an action as it is now.
export function TaskChip({
  id,
  slug,
  title,
  status,
}: {
  id: string
  slug: string
  title: ReactNode
  status?: string
}) {
  return (
    <a
      className={`timeline-note-link${statusClass(status)}`}
      href={taskHref(slug, id)}
    >
      {title}
    </a>
  )
}

// One quiet, unbubbled row in the conversation timeline: prose about something
// that happened, with the moment it happened trailing it. A lifecycle
// transition and an attributed task action are the same row — they differ only
// in what the prose says and in what, if anything, they stack beneath it — so
// both render through this and cannot drift apart.
export function TimelineNote({
  at,
  list,
  detail,
  children,
}: {
  at: string
  // Stacked beneath the row as a bulleted list: the several awaited tasks one
  // line can't name. Pre-built `<li>`s, since only the caller knows what links
  // where.
  list?: ReactNode
  // Revealable detail behind a disclosure triangle — a sent message's text.
  // `label` names it in the toggle's tooltip ("Show message").
  detail?: { label: string; body: ReactNode }
  // The prose. Plain inline content, so it flows and wraps as a sentence.
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const head = (
    <>
      <span className="timeline-note-text">{children}</span>
      <span className="timeline-note-time">{formatTimestamp(at)}</span>
    </>
  )
  return (
    <div className="timeline-note">
      {detail ? (
        <Collapsible
          open={open}
          onToggle={() => setOpen(!open)}
          summary={head}
          toggleLabel={`${open ? 'Hide' : 'Show'} ${detail.label}`}
          toggleTitle={`${open ? 'Hide' : 'Show'} ${detail.label}`}
        >
          <div className="timeline-note-detail">{detail.body}</div>
        </Collapsible>
      ) : (
        // The same row a disclosure's summary sits on, so a note with
        // revealable detail and one without share one geometry.
        <div className="collapsible-row">{head}</div>
      )}
      {list && <ul className="timeline-note-list">{list}</ul>}
    </div>
  )
}
