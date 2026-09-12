import { isUnread } from './taskMeta'
import type { TaskWithProject } from './types'

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

export type TaskActionOption = { action: TaskAction; label: string }

// What a task offers right now: only the actions that would be both *visible
// and enabled* for its current status, so e.g. a landed task offers
// Wedge/Rest/Archive but not Land, and an archived one collapses to a single
// Restore. The rules, action by action:
//
//  - launch:     a scheduled task (scheduledFor set, resting or wedged), to run it early
//  - wedge:      any task not already wedged
//  - rest:       a wedged or landed task, to return it to rest
//  - land:       any task not already landed
//  - copyId:     any task, to copy its id to the clipboard
//  - markUnread: any task that isn't already showing unviewed updates
//  - archive:    any non-riding task (a riding one has a live run the server won't archive)
//
// In menu order, which is also the order the labels read in.
export function availableTaskActions(task: TaskWithProject): TaskActionOption[] {
  if (task.archived) return [{ action: 'restore', label: 'Restore' }]
  const options: TaskActionOption[] = []
  if (task.scheduledFor) options.push({ action: 'launch', label: 'Launch' })
  if (task.status !== 'wedged') options.push({ action: 'wedge', label: 'Wedge' })
  if (task.status === 'wedged' || task.status === 'landed')
    options.push({ action: 'rest', label: 'Rest' })
  if (task.status !== 'landed') options.push({ action: 'land', label: 'Land' })
  options.push({ action: 'copyId', label: 'Copy ID' })
  if (!isUnread(task)) options.push({ action: 'markUnread', label: 'Mark unread' })
  if (task.status !== 'riding')
    options.push({ action: 'archive', label: 'Archive' })
  return options
}
