import type { ReactNode } from 'react'
import { formatTimestamp } from './format'
import { useTaskLink } from './taskLinkContext'
import { statusClass, TaskChip, TimelineNote } from './timelineNote'
import type {
  TaskActionItem,
  TaskActionRef,
  TaskActionTrigger,
} from './types'

// A referenced task, named as it stands now: the record snapshots a title only
// when the action was taken, and the reader wants the task in front of them.
function RefLink({ task }: { task: TaskActionRef }) {
  const current = useTaskLink()(task.id, task.projectSlug)
  return (
    <TaskChip
      id={task.id}
      slug={task.projectSlug}
      title={current?.title || task.title || task.id}
      status={current?.status}
    />
  )
}

function AwaitCondition({
  trigger,
}: {
  trigger: Extract<TaskActionTrigger, { kind: 'awaiting' }>
}) {
  const single = trigger.tasks.length === 1
  return (
    <>
      {single ? <RefLink task={trigger.tasks[0]} /> : `${trigger.tasks.length} tasks`}
      {trigger.scheduledFor && (
        <span className="timeline-note-when">
          {' '}
          (or {formatTimestamp(trigger.scheduledFor)})
        </span>
      )}
    </>
  )
}

function actionCopy(item: TaskActionItem, target: ReactNode): ReactNode {
  if (item.action === 'status') {
    return (
      <>
        set task {target} to{' '}
        <span className={`timeline-note-label${statusClass(item.toStatus)}`}>
          {item.toStatus || '(empty)'}
        </span>
      </>
    )
  }

  if (item.trigger?.kind === 'scheduled') {
    return (
      <>
        {item.action === 'launch' ? 'scheduled task ' : 'scheduled a message to task '}
        {target} for{' '}
        <span className="timeline-note-when">
          {formatTimestamp(item.trigger.scheduledFor)}
        </span>
      </>
    )
  }

  if (item.trigger?.kind === 'awaiting') {
    return (
      <>
        {item.action === 'launch' ? 'task ' : 'message to task '}
        {target} awaiting <AwaitCondition trigger={item.trigger} />
      </>
    )
  }

  return item.action === 'launch' ? (
    <>launched task {target}</>
  ) : (
    <>messaged task {target}</>
  )
}

// An action this task took on another one. It renders inside the turn that took
// it (`inTurn`), falling back to a row of its own when there was no turn to
// anchor to. The same note a lifecycle transition uses, differing only in that a
// sent message hangs its text off the row as revealable detail — so the row
// reads as an account of the exchange, not just that one happened.
export function TaskActionNote({
  item,
  inTurn,
}: {
  item: TaskActionItem
  inTurn?: boolean
}) {
  const target = <RefLink task={item.target} />
  const trigger = item.action === 'status' ? undefined : item.trigger
  const awaiting = trigger?.kind === 'awaiting' ? trigger : undefined
  const sent = item.action === 'message' ? item.text : undefined
  return (
    <TimelineNote
      at={item.at}
      inTurn={inTurn}
      list={
        awaiting &&
        awaiting.tasks.length > 1 &&
        awaiting.tasks.map((task) => (
          <li key={`${task.projectSlug}/${task.id}`}>
            <RefLink task={task} />
          </li>
        ))
      }
      detail={sent ? { label: 'message', body: sent } : undefined}
    >
      {actionCopy(item, target)}
    </TimelineNote>
  )
}
