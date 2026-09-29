import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Navbar, pageTitle } from './navbar'
import type { Project } from './types'

const P = (path: string): Project => ({
  path,
  slug: path.split('/').pop() ?? path,
})
const THREE = [P('/code/alpha'), P('/code/beta'), P('/code/gamma')]

describe('pageTitle', () => {
  it('falls back to "lander" before a project is known', () => {
    expect(pageTitle(undefined, 'any', 'inbox')).toBe('lander')
  })

  it('names the project by its path leaf', () => {
    expect(pageTitle('/code/beta', 'any', 'inbox')).toBe('beta')
  })

  it('appends the non-default time filter and view, time first', () => {
    expect(pageTitle('/code/beta', 'today', 'unread')).toBe(
      'beta • Today • Unread',
    )
    expect(pageTitle('/code/beta', 'any', 'archived')).toBe('beta • Archived')
  })
})

describe('Navbar', () => {
  const render = (project: string, hooksOpen = false) =>
    renderToStaticMarkup(
      <Navbar
        projects={THREE}
        project={project}
        setProject={() => {}}
        hooksOpen={hooksOpen}
        onToggleHooks={() => {}}
      />,
    )

  it('draws every project as a segment, checking the open one', () => {
    const html = render('beta')
    for (const leaf of ['alpha', 'beta', 'gamma']) expect(html).toContain(leaf)
    expect(html.match(/role="radio"/g)).toHaveLength(3)
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-checked="true"[^>]*>beta</)
  })

  it('presses the hooks button while the panel is open', () => {
    expect(render('beta')).toContain('aria-pressed="false"')
    expect(render('beta', true)).toContain('aria-pressed="true"')
  })
})
