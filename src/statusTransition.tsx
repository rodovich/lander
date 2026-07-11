import { formatTimestamp } from './format'
import type { TaskLinkResolver } from './markdown'
import type { EventItem } from './types'

// How each lifecycle event verb reads in the timeline.
const EVENT_VERB: Record<EventItem['eventKind'], string> = {
  launched: 'launched',
  scheduled: 'scheduled',
  awaiting: 'awaiting',
  wedged: 'wedged',
  unwedged: 'un-wedged',
  landed: 'landed',
  unlanded: 'un-landed',
  renamed: 'renamed',
  relaunched: 'relaunched',
}

// A lifecycle event shown inline in the conversation: the task's name (as of
// that moment) followed by the verb — e.g. "Fix the parser launched". The name
// is italic and the verb is set apart by weight/color (each verb wears its
// status color — launched like riding, wedged, landed — plain otherwise).
// Presented like the
// working-spinner row (unbubbled, muted) but without the spinner, since the
// event is complete.
export function StatusTransition({
  event,
  slug,
  linkTask,
}: {
  event: EventItem
  slug: string
  linkTask: TaskLinkResolver
}) {
  // An "awaiting" event reads "<name> awaiting <task>" with the awaited task
  // linked; with several, it reads "<name> awaiting <N> tasks" and lists them as
  // links below. Any time fallback the task also has isn't shown — the condition
  // is the point.
  if (event.eventKind === 'awaiting') {
    const tasks = event.awaiting ?? []
    const single = tasks.length === 1
    // Tint each awaited link by its task's current status (when resolvable),
    // matching the status chips used for task mentions.
    const link = (t: { id: string; title: string }) => {
      const status = linkTask(t.id)?.status
      return (
        <a
          className={`status-transition-await-link${status ? ` ${status}` : ''}`}
          href={`/${slug}/${t.id}`}
        >
          {t.title}
        </a>
      )
    }
    return (
      <div className="status-transition status-transition-awaiting">
        <div className="status-transition-await-head">
          <span className="status-transition-event">
            {event.title && (
              <span className="status-transition-name">{event.title}</span>
            )}
            <span className="status-transition-label awaiting">
              awaiting{single ? '' : ` ${tasks.length} tasks`}
            </span>
            {single && link(tasks[0])}
          </span>
          <span className="status-transition-time">
            {formatTimestamp(event.at)}
          </span>
        </div>
        {!single && (
          <ul className="status-transition-await-list">
            {tasks.map((t) => (
              <li key={t.id}>{link(t)}</li>
            ))}
          </ul>
        )}
      </div>
    )
  }
  return (
    <div className="status-transition">
      <span className="status-transition-event">
        {event.title && (
          <span className="status-transition-name">{event.title}</span>
        )}
        <span className={`status-transition-label ${event.eventKind}`}>
          {EVENT_VERB[event.eventKind]}
          {/* A 'scheduled' rest and an armed scheduled 'relaunch' both show the
              time they'll fire beside the verb. */}
          {(event.eventKind === 'scheduled' ||
            event.eventKind === 'relaunched') &&
            event.scheduledFor && (
              <span className="status-transition-when">
                {' '}
                {formatTimestamp(event.scheduledFor)}
              </span>
            )}
        </span>
      </span>
      <span className="status-transition-time">
        {formatTimestamp(event.at)}
      </span>
    </div>
  )
}
