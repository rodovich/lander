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

// One action a task offers. `group` says what kind of thing it does — move the
// task between statuses, or act on it some other way — so a menu can set the
// two kinds apart without knowing which action is which.
export type TaskActionOption = {
  action: TaskAction
  label: string
  group: 'status' | 'other'
}

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
// In menu order: every status action ahead of every other one.
export function availableTaskActions(task: TaskWithProject): TaskActionOption[] {
  if (task.archived)
    return [{ action: 'restore', label: 'Restore', group: 'status' }]
  const options: TaskActionOption[] = []
  const status = (action: TaskAction, label: string) =>
    options.push({ action, label, group: 'status' })
  const other = (action: TaskAction, label: string) =>
    options.push({ action, label, group: 'other' })
  if (task.scheduledFor) status('launch', 'Launch')
  if (task.status !== 'wedged') status('wedge', 'Wedge')
  if (task.status === 'wedged' || task.status === 'landed') status('rest', 'Rest')
  if (task.status !== 'landed') status('land', 'Land')
  other('copyId', 'Copy ID')
  if (!isUnread(task)) other('markUnread', 'Mark unread')
  if (task.status !== 'riding') other('archive', 'Archive')
  return options
}
