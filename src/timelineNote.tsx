import { useState, type ReactNode } from 'react'
import { Collapsible, CollapsibleRow } from './collapsible'
import { formatTimestamp } from './format'
import { TASK_ID, type TaskLinkResolver } from './markdown'

// The statuses that have a tint of their own. Anything else — a status this
// client doesn't know, or one carrying whitespace that would inject a second
// class — renders untinted rather than as a broken selector.
const TINTED = new Set(['riding', 'paced', 'wedged', 'landed'])

// The variant token a status contributes to a className, or nothing.
export function statusClass(status: string | undefined): string {
  return status && TINTED.has(status) ? ` ${status}` : ''
}

export function TaskStatus({ status }: { status: string }) {
  return <span className={`task-status${statusClass(status)}`}>{status}</span>
}

// A link to another task, tinted by that task's current status: the chip worn
// by an awaited task on a lifecycle event and by the subject of a task action
// alike. The caller resolves the title, because which one is right differs —
// an event names the task as it was, an action as it is now.
export function TaskChip({
  href,
  title,
  status,
  createdAt,
}: {
  href: string
  title: ReactNode
  status?: string
  createdAt?: string
}) {
  return (
    <a
      className={`timeline-note-link${statusClass(status)}`}
      href={href}
      title={createdAt ? formatTimestamp(createdAt) : undefined}
    >
      {title}
    </a>
  )
}

// For text that isn't markdown, such as an event's reason.
export function TaskMentions({ text, linkTask }: { text: string; linkTask: TaskLinkResolver }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(TASK_ID)) {
    const link = linkTask(match[0])
    if (!link) continue
    parts.push(text.slice(last, match.index), <TaskChip key={match.index} {...link} />)
    last = match.index + match[0].length
  }
  parts.push(text.slice(last))
  return <>{parts}</>
}

// One quiet, unbubbled row: prose about something that happened, with the
// moment it happened trailing it. A lifecycle transition and an attributed task
// action say different things, and now stand in different places — the first on
// the timeline, the second inside the turn that took it — but they are the same
// sentence with the same chips in it, so both render through this and their
// wording cannot drift apart.
export function TimelineNote({
  at,
  inTurn,
  variant,
  list,
  detail,
  children,
}: {
  at: string
  // A second class on the row (`message-queued`).
  variant?: string
  // Rendered inside an assistant turn rather than on the timeline rail. The
  // turn already says when it ran and the notes group at one point in it, so
  // the row drops its timestamp (kept as the row's tooltip, where the exact
  // moment is still there for anyone who wants it) and its rail tint.
  inTurn?: boolean
  // Stacked beneath the row as a bulleted list: the several awaited tasks one
  // line can't name. Pre-built `<li>`s, since only the caller knows what links
  // where.
  list?: ReactNode
  // Revealable detail behind a disclosure triangle — a sent message's text.
  // `label` names it in the toggle's tooltip ("Show message"). Each new truthy
  // `openOn` opens it — a search match landing inside — in the same render, so
  // the detail is in the page by the time the caller scrolls to it.
  detail?: { label: string; body: ReactNode; openOn?: unknown }
  // The prose. Plain inline content, so it flows and wraps as a sentence.
  children: ReactNode
}) {
  const openOn = detail?.openOn
  const [open, setOpen] = useState(!!openOn)
  const [seenOpenOn, setSeenOpenOn] = useState(openOn)
  if (openOn !== seenOpenOn) {
    setSeenOpenOn(openOn)
    if (openOn) setOpen(true)
  }
  const head = (
    <>
      <span className="timeline-note-text">{children}</span>
      {!inTurn && (
        <span className="timeline-note-time">{formatTimestamp(at)}</span>
      )}
    </>
  )
  return (
    <div
      className={`timeline-note${inTurn ? ' in-turn' : ''}${variant ? ` ${variant}` : ''}`}
      title={inTurn ? formatTimestamp(at) : undefined}
    >
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
        <CollapsibleRow>{head}</CollapsibleRow>
      )}
      {list && <ul className="timeline-note-list">{list}</ul>}
    </div>
  )
}
