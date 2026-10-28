import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatTimestamp } from './format'
import { Markdown } from './markdown'
import { TaskChip } from './timelineNote'

const ID = 'gqc9qIVd_F'
const CREATED = '2026-08-21T20:00:00.000Z'

describe('task link tooltips', () => {
  it('shows the creation time for full and abbreviated conversation mentions', () => {
    const linkTask = () => ({
      href: `/proj/${ID}`,
      title: 'Fix the parser',
      status: 'paced',
      createdAt: CREATED,
    })
    for (const text of [ID, ID.slice(0, 8)]) {
      const html = renderToStaticMarkup(<Markdown text={text} linkTask={linkTask} />)
      expect(html).toContain(`title="${formatTimestamp(CREATED)}"`)
      expect(html).toContain(`href="/proj/${ID}"`)
      expect(html).not.toContain(`title="${text}"`)
    }
  })

  it('shows the creation time on task chips used in conversation notes', () => {
    const html = renderToStaticMarkup(
      <TaskChip id={ID} slug="proj" title="A task" createdAt={CREATED} />,
    )
    expect(html).toContain(`title="${formatTimestamp(CREATED)}"`)
  })

  it('keeps links usable when the API projection has no creation time', () => {
    const html = renderToStaticMarkup(
      <Markdown text={ID} linkTask={() => ({
        href: `/proj/${ID}`,
        title: 'Old task',
        status: 'landed',
      })} />,
    )
    expect(html).toContain(`href="/proj/${ID}"`)
    expect(html).not.toContain(' title=')
  })
})
