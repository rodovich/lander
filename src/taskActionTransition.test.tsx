import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskActionTransition } from './taskActionTransition'
import type { TaskActionItem } from './types'

const AT = '2026-08-21T20:00:00.000Z'
const target = { id: 'child-id', projectSlug: 'other', title: 'Stored child' }

const render = (
  item: TaskActionItem,
  linkTask: (id: string, projectSlug?: string) =>
    | { href: string; title: string; status: string }
    | undefined = () => undefined,
) => renderToStaticMarkup(<TaskActionTransition item={item} linkTask={linkTask} />)

describe('TaskActionTransition', () => {
  it('renders an immediate launch with an authoritative pair href and current metadata', () => {
    const linkTask = vi.fn(() => ({
      href: '/wrong/wrong',
      title: 'Current child',
      status: 'landed',
    }))
    const html = render(
      { id: 'a1', at: AT, kind: 'task-action', action: 'launch', target },
      linkTask,
    )
    expect(linkTask).toHaveBeenCalledWith('child-id', 'other')
    expect(html).toContain('launched task')
    expect(html).toContain('Current child')
    expect(html).toContain('href="/other/child-id"')
    expect(html).toContain('timeline-note-link landed')
    expect(html).not.toContain('/wrong/wrong')
  })

  it('renders scheduled and awaiting launch/message variants with fallback labels', () => {
    const scheduled = render({
      id: 'a1',
      at: AT,
      kind: 'task-action',
      action: 'launch',
      target,
      trigger: { kind: 'scheduled', scheduledFor: AT },
    })
    expect(scheduled).toContain('scheduled task')
    expect(scheduled).toContain('Stored child')

    const awaiting = render({
      id: 'a2',
      at: AT,
      kind: 'task-action',
      action: 'message',
      target,
      trigger: {
        kind: 'awaiting',
        tasks: [
          { id: 'gate-1', projectSlug: 'proj', title: 'First gate' },
          { id: 'gate-2', projectSlug: 'proj' },
        ],
        scheduledFor: AT,
      },
    })
    expect(awaiting).toContain('message to task')
    expect(awaiting).toContain('awaiting')
    expect(awaiting).toContain('2 tasks')
    expect(awaiting).toContain('First gate')
    expect(awaiting).toContain('gate-2')
    expect(awaiting).toContain('(or ')
  })

  it('renders immediate messages and whitelisted or neutral status states', () => {
    expect(
      render({
        id: 'a1',
        at: AT,
        kind: 'task-action',
        action: 'message',
        target,
      }),
    ).toContain('messaged task')

    // Nothing to reveal: a plain row, never a dead disclosure triangle.
    expect(
      render({
        id: 'a1',
        at: AT,
        kind: 'task-action',
        action: 'message',
        target,
      }),
    ).not.toContain('collapsible-toggle')

    // A sent message becomes a disclosure, closed until the reader opens it.
    const sent = render({
      id: 'a1',
      at: AT,
      kind: 'task-action',
      action: 'message',
      target,
      text: 'Land once the suite is green.',
    })
    expect(sent).toContain('aria-expanded="false"')
    expect(sent).toContain('Show message')
    expect(sent).not.toContain('Land once the suite is green.')

    const landed = render({
      id: 'a2',
      at: AT,
      kind: 'task-action',
      action: 'status',
      target,
      toStatus: 'landed',
    })
    expect(landed).toContain('set task')
    expect(landed).toContain('timeline-note-label landed')

    const unknown = render({
      id: 'a3',
      at: AT,
      kind: 'task-action',
      action: 'status',
      target,
      toStatus: 'landed sidebar',
    })
    expect(unknown).toContain('landed sidebar')
    expect(unknown).toContain('class="timeline-note-label"')
    expect(unknown).not.toContain('timeline-note-label landed sidebar')
  })
})
