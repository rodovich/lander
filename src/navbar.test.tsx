import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Navbar, pageTitle, type Panel } from './navbar'
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
  const render = (project: string, panel: Panel | null = null) =>
    renderToStaticMarkup(
      <Navbar
        projects={THREE}
        project={project}
        setProject={() => {}}
        panel={panel}
        onTogglePanel={() => {}}
      />,
    )

  it('draws every project as a segment, checking the open one', () => {
    const html = render('beta')
    for (const leaf of ['alpha', 'beta', 'gamma']) expect(html).toContain(leaf)
    expect(html.match(/role="radio"/g)).toHaveLength(3)
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-checked="true"[^>]*>beta</)
  })

  it('presses only the open panel’s button', () => {
    expect(render('beta')).not.toContain('aria-pressed="true"')
    expect(render('beta', 'hooks')).toMatch(/aria-pressed="true"[^>]*>Hooks</)
    expect(render('beta', 'stats')).toMatch(/aria-pressed="true"[^>]*>Stats</)
    expect(render('beta', 'stats').match(/aria-pressed="true"/g)).toHaveLength(1)
  })
})
