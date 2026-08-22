import { formatTimestamp } from './format'
import type { TaskLinkResolver } from './markdown'
import { TaskChip, TimelineNote } from './timelineNote'
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
// that moment) followed by the verb — e.g. "Fix the parser launched". The verb
// is set apart by weight/color (each verb wears its status color — launched
// like riding, wedged, landed — plain otherwise). It rides the shared timeline
// note, so it reads exactly like an attributed task action.
export function StatusTransition({
  event,
  slug,
  linkTask,
}: {
  event: EventItem
  slug: string
  linkTask: TaskLinkResolver
}) {
  // The name the task went by at the time, leading the sentence.
  const name = event.title ? `${event.title} ` : ''

  // An "awaiting" event reads "<name> awaiting <task>" with the awaited task
  // linked; with several, it reads "<name> awaiting <N> tasks" and lists them as
  // links below. Any time fallback the task also has isn't shown — the condition
  // is the point.
  if (event.eventKind === 'awaiting') {
    const tasks = event.awaiting ?? []
    const single = tasks.length === 1
    // Tint each awaited link by its task's current status (when resolvable),
    // matching the status chips used for task mentions.
    const chip = (t: { id: string; title: string }) => (
      <TaskChip
        id={t.id}
        slug={slug}
        title={t.title}
        status={linkTask(t.id, slug)?.status}
      />
    )
    return (
      <TimelineNote
        at={event.at}
        list={
          !single && tasks.map((t) => <li key={t.id}>{chip(t)}</li>)
        }
      >
        {name}
        <span className="timeline-note-label awaiting">
          awaiting{single ? '' : ` ${tasks.length} tasks`}
        </span>
        {single && <> {chip(tasks[0])}</>}
      </TimelineNote>
    )
  }
  return (
    <TimelineNote at={event.at}>
      {name}
      <span className={`timeline-note-label ${event.eventKind}`}>
        {EVENT_VERB[event.eventKind]}
        {/* A 'scheduled' rest and an armed scheduled 'relaunch' both show the
            time they'll fire beside the verb. */}
        {(event.eventKind === 'scheduled' ||
          event.eventKind === 'relaunched') &&
          event.scheduledFor && (
            <span className="timeline-note-when">
              {' '}
              {formatTimestamp(event.scheduledFor)}
            </span>
          )}
      </span>
    </TimelineNote>
  )
}
