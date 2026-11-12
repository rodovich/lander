import { formatTaskTime, unit } from './format'
import { ActionsMenu } from './menus'
import { TaskStatus } from './timelineNote'
import type { TaskWithProject } from './types'

// The tasks a task launched to manage, as a chip naming how many there are, and
// a menu listing them in the list's order. Nothing when there are none.
export function SubtasksChip({
  subtasks = [],
  todayStart,
  onOpen,
}: {
  subtasks?: TaskWithProject[]
  todayStart: number
  onOpen: (id: string, projectSlug: string) => void
}) {
  const count = unit(subtasks.length, 'subtask')
  const working = subtasks.some((t) => t.status === 'riding')
  return (
    <ActionsMenu
      className="subtasks"
      popupClassName="subtasks-popup"
      trigger={{
        className: 'subtasks-chip',
        content: (
          <>
            {count}
            {working && <span className="riding-spinner" />}
          </>
        ),
      }}
      triggerLabel={working ? `${count}, working` : count}
      items={subtasks.map((task) => ({
        key: task.id,
        className: 'subtasks-item',
        label: (
          <>
            <span className="subtasks-title">{task.title}</span>
            <TaskStatus status={task.status} />
            <span className="subtasks-time">
              {formatTaskTime(task.updatedAt ?? task.createdAt, todayStart)}
            </span>
          </>
        ),
        onSelect: () => onOpen(task.id, task.projectSlug),
      }))}
    />
  )
}
