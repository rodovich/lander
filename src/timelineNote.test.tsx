import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { statusClass, TaskChip, TimelineNote } from './timelineNote'

const AT = '2026-08-21T20:00:00.000Z'

describe('TimelineNote', () => {
  it('trails the prose with its timestamp on one row', () => {
    const html = renderToStaticMarkup(
      <TimelineNote at={AT}>launched something</TimelineNote>,
    )
    // Prose and time are siblings on the row, in that order — the time follows
    // the sentence rather than being pushed to the far edge.
    expect(html).toMatch(
      /<div class="collapsible-row"><span class="timeline-note-text">launched something<\/span><span class="timeline-note-time">/,
    )
    expect(html).not.toContain('collapsible-toggle')
  })

  it('stacks a list beneath the row and holds detail closed behind a triangle', () => {
    const html = renderToStaticMarkup(
      <TimelineNote
        at={AT}
        list={[<li key="a">first</li>, <li key="b">second</li>]}
        detail={{ label: 'message', body: 'the body' }}
      >
        did a thing
      </TimelineNote>,
    )
    expect(html).toContain('<ul class="timeline-note-list"><li>first</li>')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Show message')
    expect(html).not.toContain('the body')
  })
})

describe('TaskChip', () => {
  it('tints only a status the stylesheet knows', () => {
    const chip = (status?: string) =>
      renderToStaticMarkup(
        <TaskChip id="abc" slug="proj" title="A task" status={status} />,
      )
    expect(chip('wedged')).toContain('class="timeline-note-link wedged"')
    expect(chip('wedged')).toContain('href="/proj/abc"')
    // An unknown status — or one carrying whitespace, which would inject a
    // second class — leaves the chip in its default tint.
    expect(chip('landed sidebar')).toContain('class="timeline-note-link"')
    expect(chip(undefined)).toContain('class="timeline-note-link"')
    expect(statusClass('riding')).toBe(' riding')
    expect(statusClass('nonsense')).toBe('')
  })
})
