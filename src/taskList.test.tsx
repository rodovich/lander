import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { TaskList } from './taskList'
import { buildTaskRows } from './taskRows'
import type { TaskWithProject } from './types'

// A fixed "now" (Wednesday June 24, 2026, local time) keeps date bucketing
// deterministic, matching taskRows.test.ts.
const NOW = new Date(2026, 5, 24, 12, 0, 0)
const at = (daysAgo: number, hour = 9) =>
  new Date(2026, 5, 24 - daysAgo, hour, 0, 0).toISOString()

let seq = 0
const task = (over: Partial<TaskWithProject> = {}): TaskWithProject => ({
  id: `t${seq++}`,
  agent: 'claude',
  title: `Task ${seq}`,
  status: 'paced',
  createdAt: at(0),
  allowEdits: true,
  projectSlug: 'proj',
  ...over,
})

const render = (
  tasks: TaskWithProject[],
  over: Partial<ComponentProps<typeof TaskList>> = {},
  view: 'inbox' | 'unread' | 'archived' = 'inbox',
  query = '',
) => {
  const shape = buildTaskRows(tasks, {
    view,
    timeFilter: 'any',
    query,
    stickyUnread: new Set(),
    now: NOW,
  })
  return renderToStaticMarkup(
    <TaskList
      shape={shape}
      tasksEmpty={tasks.length === 0}
      hasProjects={true}
      view={view}
      setView={() => {}}
      timeFilter="any"
      setTimeFilter={() => {}}
      filter={query}
      setFilter={() => {}}
      selected={null}
      onSelect={() => {}}
      onFocusChange={() => {}}
      onTaskAction={() => {}}
      onArchiveSection={() => {}}
      onOpenMatch={() => {}}
      {...over}
    />,
  )
}

describe('TaskList empty states', () => {
  it('distinguishes an empty inbox from an all-filtered one', () => {
    expect(render([])).toContain('No tasks yet')
    const html = render([task({ title: 'Deploy' })], {}, 'inbox', 'zzz')
    expect(html).toContain('No matching tasks')
    expect(html).not.toContain('No tasks yet')
  })
})

describe('TaskList roving tabindex', () => {
  it('makes only the selected row Tab-reachable', () => {
    const html = render(
      [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })],
      { selected: 'proj/b' },
    )
    expect(html.split('tabindex="0"').length - 1).toBe(1)
    expect(html.split('tabindex="-1"').length - 1).toBe(2)
    expect(html).toContain('aria-selected="true"')
  })

  it('falls back to the first row when nothing is selected', () => {
    const html = render([task({ id: 'a' }), task({ id: 'b' })])
    expect(html.split('tabindex="0"').length - 1).toBe(1)
  })
})

describe('TaskList schedule indicators', () => {
  it('shows the clock for a scheduled launch, an await, and a deferred send', () => {
    expect(render([task({ scheduledFor: at(-1) })])).toContain(
      'aria-label="Scheduled"',
    )
    expect(render([task({ waitingFor: ['other'] })])).toContain(
      'aria-label="Awaiting"',
    )
    // A plain deferred send (deliverAt, no relaunch flag) — the case that once
    // regressed to no indicator at all.
    expect(
      render([task({ scheduledMessages: [{ deliverAt: at(-1) }] })]),
    ).toContain('aria-label="Scheduled"')
    expect(
      render([task({ scheduledMessages: [{ waitFor: ['other'] }] })]),
    ).toContain('aria-label="Awaiting"')
  })

  it('shows the repeat arrow only for a repeating relaunch', () => {
    const html = render([
      task({ scheduledMessages: [{ deliverAt: at(-1), repeat: { every: 5 } }] }),
    ])
    expect(html).toContain('aria-label="Repeats"')
    expect(render([task({})])).not.toContain('aria-label="Repeats"')
  })

  it('shows no clock on a plain task, and the spinner while riding', () => {
    const plain = render([task({})])
    expect(plain).not.toContain('scheduled-clock')
    expect(render([task({ status: 'riding' })])).toContain('riding-spinner')
  })
})

describe('TaskList row badges', () => {
  it('marks archived and unread rows', () => {
    const html = render([
      task({ archived: true }),
      // readThrough behind the latest event → unread dot.
      task({
        readThrough: at(1),
        items: [{ id: 'e1', at: at(0), kind: 'event', eventKind: 'wedged' }],
      }),
    ])
    expect(html).toContain('task-archived-tag')
    expect(html).toContain('unseen-dot')
  })
})

describe('TaskList search matches', () => {
  const said = (id: string, text: string) => ({
    id,
    at: at(0),
    kind: 'message' as const,
    role: 'user' as const,
    text,
  })

  it('marks the query in the title and lists conversation matches under the row', () => {
    const html = render(
      [
        task({ title: 'Permission audit' }),
        task({ title: 'Other', items: [said('m1', 'needs permissioning first')] }),
      ],
      {},
      'inbox',
      'permission',
    )
    expect(html).toContain('<mark class="text-highlight">Permission</mark> audit')
    expect(html).toContain('needs <mark class="text-highlight">permission</mark>ing first')
    // Only the conversation match gets a subrow; the title match has none.
    expect(html.split('class="list-subrow"').length - 1).toBe(1)
    expect(html).toContain('list-subrow-end')
  })

  it('shows the first three matches, then a link to the rest', () => {
    const items = Array.from({ length: 5 }, (_, i) => said(`m${i}`, `hit ${i}`))
    const html = render([task({ items })], {}, 'inbox', 'hit')
    expect(html.split('class="list-subrow"').length - 1).toBe(3)
    expect(html).toContain('class="list-subrow link"')
    expect(html).toContain('Show 2 more')
  })

  it('lists nothing under the rows when not searching', () => {
    const html = render([task({ items: [said('m1', 'anything')] })])
    expect(html).not.toContain('list-subrow')
    expect(html).not.toContain('text-highlight')
  })
})

describe('TaskList section headers', () => {
  it('splits a multi-bucket status into date subheaders and counts its chips', () => {
    const html = render([
      task({ status: 'landed', updatedAt: at(0) }),
      task({ status: 'landed', updatedAt: at(2) }),
      task({ status: 'paced', updatedAt: at(0) }),
    ])
    // paced outranks landed, so the landed header is not `first`.
    expect(html).toContain('task-group-header status landed split')
    expect(html).toContain('task-group-header status paced first')
    expect(html).toContain('task-group-header date landed')
    // The count chips row renders one chip per status present.
    expect(html.split('task-count-num').length - 1).toBe(2)
  })

  it('offers no archive menu on riding sections or in the archived view', () => {
    expect(render([task({ status: 'riding' })])).not.toContain('section-menu')
    expect(
      render([task({ status: 'landed', archived: true })], {}, 'archived'),
    ).not.toContain('section-menu')
    expect(render([task({ status: 'landed' })])).toContain('section-menu')
  })
})
