import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusTransition } from './statusTransition'
import type { EventItem } from './types'

const AT = '2026-08-21T20:00:00.000Z'

const render = (
  event: EventItem,
  linkTask: (id: string, projectSlug?: string) =>
    | { href: string; title: string; status: string }
    | undefined = () => undefined,
) =>
  renderToStaticMarkup(
    <StatusTransition event={event} slug="proj" linkTask={linkTask} />,
  )

const base = { id: 'e1', at: AT, kind: 'event' } as const

describe('StatusTransition', () => {
  it('reads as the task’s name followed by the verb', () => {
    const html = render({
      ...base,
      eventKind: 'landed',
      title: 'Fix the parser',
    })
    expect(html).toContain('Fix the parser <span class="timeline-note-label landed">landed')
  })

  it('shows the firing time beside a scheduled verb', () => {
    const html = render({
      ...base,
      eventKind: 'scheduled',
      title: 'Nightly sweep',
      scheduledFor: AT,
    })
    expect(html).toContain('timeline-note-label scheduled')
    expect(html).toContain('timeline-note-when')
  })

  it('keeps one awaited task inline and stacks several below', () => {
    const single = render(
      {
        ...base,
        eventKind: 'awaiting',
        title: 'Gate',
        awaiting: [{ id: 'w1', title: 'First gate' }],
      },
      () => ({ href: '/proj/w1', title: 'First gate', status: 'landed' }),
    )
    expect(single).toContain('awaiting</span> ')
    expect(single).toContain('class="timeline-note-link landed"')
    expect(single).not.toContain('timeline-note-list')

    const several = render({
      ...base,
      eventKind: 'awaiting',
      title: 'Gate',
      awaiting: [
        { id: 'w1', title: 'First gate' },
        { id: 'w2', title: 'Second gate' },
      ],
    })
    expect(several).toContain('awaiting 2 tasks')
    expect(several).toContain('<ul class="timeline-note-list">')
    expect(several).toContain('Second gate')
  })
})
