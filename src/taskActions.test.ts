import { describe, expect, it } from 'vitest'
import { availableTaskActions } from './taskActions'
import type { TaskWithProject } from './types'

const AT = '2026-06-26T10:00:00.000Z'
const LATER = '2026-06-26T11:00:00.000Z'

const task = (over: Partial<TaskWithProject> = {}): TaskWithProject => ({
  id: 'task1',
  agent: 'claude',
  title: 'Fix the parser',
  status: 'resting',
  createdAt: AT,
  allowEdits: true,
  projectSlug: 'proj',
  items: [],
  rides: [],
  ...over,
})

const actions = (over: Partial<TaskWithProject> = {}) =>
  availableTaskActions(task(over)).map((o) => o.action)

describe('availableTaskActions', () => {
  it('offers every status change a resting task can make', () => {
    expect(actions()).toEqual(['wedge', 'land', 'copyId', 'markUnread', 'archive'])
  })

  it('never offers the status a task already holds', () => {
    expect(actions({ status: 'wedged' })).not.toContain('wedge')
    expect(actions({ status: 'landed' })).not.toContain('land')
  })

  it('offers Rest only to a task that has somewhere to come back from', () => {
    expect(actions({ status: 'wedged' })).toContain('rest')
    expect(actions({ status: 'landed' })).toContain('rest')
    expect(actions({ status: 'resting' })).not.toContain('rest')
    expect(actions({ status: 'riding' })).not.toContain('rest')
  })

  // A riding task has a live run the server won't archive.
  it('withholds Archive from a riding task', () => {
    expect(actions({ status: 'riding' })).not.toContain('archive')
    expect(actions({ status: 'resting' })).toContain('archive')
  })

  it('offers Launch only to a task with a scheduled start to bring forward', () => {
    expect(actions({ scheduledFor: LATER })).toContain('launch')
    expect(actions()).not.toContain('launch')
  })

  it('withholds Mark unread from a task already showing unviewed updates', () => {
    const unread = { seenAt: AT, items: [{ id: 'm1', at: LATER, kind: 'message', role: 'user', text: 'hi' }] } as Partial<TaskWithProject>
    expect(actions(unread)).not.toContain('markUnread')
    expect(actions({ seenAt: LATER })).toContain('markUnread')
  })

  it('collapses an archived task to a single Restore', () => {
    expect(availableTaskActions(task({ archived: true, status: 'landed' }))).toEqual([
      { action: 'restore', label: 'Restore', group: 'status' },
    ])
  })

  // The menu rules a line wherever the group changes, so the status actions
  // must all come first or it would draw more than one.
  it('groups the status changes ahead of everything else', () => {
    const groups = (over: Partial<TaskWithProject>) =>
      availableTaskActions(task(over)).map((o) => `${o.action}:${o.group}`)
    expect(groups({ status: 'wedged', scheduledFor: LATER })).toEqual([
      'launch:status',
      'rest:status',
      'land:status',
      'copyId:other',
      'markUnread:other',
      'archive:other',
    ])
  })
})
