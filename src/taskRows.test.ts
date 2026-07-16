import { describe, it, expect } from 'vitest'
import { buildTaskRows } from './taskRows'
import type { TaskWithProject, TaskView, TimeFilter } from './types'

// A fixed "now" mid-week (Wednesday June 24, 2026, local time) so today/week/
// older bucketing is deterministic. Task times are built relative to it.
const NOW = new Date(2026, 5, 24, 12, 0, 0)
const at = (daysAgo: number, hour = 9) => {
  const d = new Date(2026, 5, 24 - daysAgo, hour, 0, 0)
  return d.toISOString()
}

let seq = 0
const task = (over: Partial<TaskWithProject> = {}): TaskWithProject => ({
  id: `t${seq++}`,
  agent: 'claude',
  title: `Task ${seq}`,
  status: 'resting',
  createdAt: at(0),
  allowEdits: true,
  projectSlug: 'proj',
  ...over,
})

const build = (
  tasks: TaskWithProject[],
  over: Partial<{
    view: TaskView
    timeFilter: TimeFilter
    query: string
    stickyUnread: Set<string>
  }> = {},
) =>
  buildTaskRows(tasks, {
    view: 'inbox',
    timeFilter: 'any',
    query: '',
    stickyUnread: new Set(),
    now: NOW,
    ...over,
  })

// Render rows as short tags so order assertions stay readable:
// "s:riding" (status header), "d:today" (date subheader), task id.
const tags = (shape: ReturnType<typeof buildTaskRows>) =>
  shape.taskRows.map((r) =>
    r.kind === 'status'
      ? `s:${r.status}`
      : r.kind === 'date'
        ? `d:${r.category}`
        : r.task.id,
  )

describe('buildTaskRows', () => {
  it('orders status groups wedged, riding, resting, landed', () => {
    const shape = build([
      task({ id: 'a', status: 'landed' }),
      task({ id: 'b', status: 'resting' }),
      task({ id: 'c', status: 'wedged' }),
      task({ id: 'd', status: 'riding' }),
    ])
    expect(shape.orderedTasks.map((t) => t.id)).toEqual(['c', 'd', 'b', 'a'])
    expect(tags(shape)).toEqual([
      's:wedged', 'c',
      's:riding', 'd',
      's:resting', 'b',
      's:landed', 'a',
    ])
  })

  it('keeps recency order within a status and ranks unknown statuses ahead of landed', () => {
    const shape = build([
      task({ id: 'new', status: 'resting', updatedAt: at(0) }),
      task({ id: 'old', status: 'resting', updatedAt: at(1) }),
      task({ id: 'odd', status: 'mystery', updatedAt: at(0) }),
      task({ id: 'done', status: 'landed', updatedAt: at(0) }),
    ])
    expect(shape.orderedTasks.map((t) => t.id)).toEqual([
      'new', 'old', 'odd', 'done',
    ])
  })

  it('marks only the first header `first` and indexes task rows into orderedTasks', () => {
    const shape = build([
      task({ id: 'a', status: 'riding' }),
      task({ id: 'b', status: 'landed' }),
    ])
    const headers = shape.taskRows.filter((r) => r.kind === 'status')
    expect(headers.map((h) => h.kind === 'status' && h.first)).toEqual([
      true,
      false,
    ])
    const rows = shape.taskRows.filter((r) => r.kind === 'task')
    for (const r of rows) {
      if (r.kind !== 'task') continue
      expect(shape.orderedTasks[r.index].id).toBe(r.task.id)
    }
  })

  it('splits a status into date subheaders only when it spans multiple buckets', () => {
    const shape = build([
      task({ id: 'today1', status: 'landed', updatedAt: at(0) }),
      task({ id: 'today2', status: 'landed', updatedAt: at(0, 8) }),
      task({ id: 'week', status: 'landed', updatedAt: at(2) }),
      task({ id: 'single', status: 'resting', updatedAt: at(0) }),
    ])
    expect(tags(shape)).toEqual([
      's:resting', 'single',
      's:landed', 'd:today', 'today1', 'today2', 'd:week', 'week',
    ])
    expect(shape.dateCatsByStatus.get('landed')?.size).toBe(2)
    expect(shape.dateCatsByStatus.get('resting')?.size).toBe(1)
    expect(shape.countByStatusDate.get('landed|today')).toBe(2)
    expect(shape.countByStatusDate.get('landed|week')).toBe(1)
  })

  it('filters by the time window', () => {
    const tasks = [
      task({ id: 'today', updatedAt: at(0) }),
      task({ id: 'week', updatedAt: at(2) }), // Monday — this week
      task({ id: 'older', updatedAt: at(7) }), // last week
    ]
    expect(build(tasks, { timeFilter: 'today' }).orderedTasks.map((t) => t.id))
      .toEqual(['today'])
    expect(build(tasks, { timeFilter: 'week' }).orderedTasks.map((t) => t.id))
      .toEqual(['today', 'week'])
    expect(build(tasks, { timeFilter: 'older' }).orderedTasks.map((t) => t.id))
      .toEqual(['older'])
    expect(build(tasks, { timeFilter: 'any' }).orderedTasks).toHaveLength(3)
  })

  it('falls back to createdAt for the time filter and keeps unparseable times', () => {
    const tasks = [
      task({ id: 'created-old', createdAt: at(9) }),
      task({ id: 'garbled', createdAt: 'not-a-date' }),
    ]
    expect(build(tasks, { timeFilter: 'today' }).orderedTasks.map((t) => t.id))
      .toEqual(['garbled'])
  })

  it('matches the query against titles, case-insensitively', () => {
    const tasks = [
      task({ id: 'hit', title: 'Fix the Parser' }),
      task({ id: 'miss', title: 'Deploy docs' }),
    ]
    expect(build(tasks, { query: 'parser' }).orderedTasks.map((t) => t.id))
      .toEqual(['hit'])
  })

  it('unread view keeps unread tasks and sticky-held read ones', () => {
    const tasks = [
      // seenAt behind the latest user message → unread.
      task({
        id: 'unread',
        seenAt: at(1),
        items: [
          { id: 'm1', at: at(0), kind: 'message', role: 'user', text: 'hi' },
        ],
      }),
      task({ id: 'read', seenAt: at(0) }),
      task({ id: 'held', seenAt: at(0) }),
    ]
    expect(
      build(tasks, { view: 'unread', stickyUnread: new Set(['held']) })
        .orderedTasks.map((t) => t.id),
    ).toEqual(['unread', 'held'])
  })

  it('counts statuses in reverse list order', () => {
    const shape = build([
      task({ id: 'a', status: 'wedged' }),
      task({ id: 'b', status: 'landed' }),
      task({ id: 'c', status: 'landed' }),
    ])
    expect(shape.statusCounts).toEqual([
      ['landed', 2],
      ['wedged', 1],
    ])
    expect(shape.countByStatus.get('landed')).toBe(2)
  })
})
