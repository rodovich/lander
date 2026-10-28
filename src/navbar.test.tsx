import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FlowTelemetry } from './api'
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
  const render = (
    project: string,
    panel: Panel | null = null,
    error: string | null = null,
    telemetry: FlowTelemetry = {},
  ) =>
    renderToStaticMarkup(
      <Navbar
        projects={THREE}
        project={project}
        setProject={() => {}}
        panel={panel}
        onTogglePanel={() => {}}
        error={error}
        telemetry={telemetry}
      />,
    )

  it('offers Usage, before Stats, only once a flow has published telemetry', () => {
    const meter = {
      id: 'session',
      label: 'Session',
      type: 'meter' as const,
      value: 40,
      max: 100,
    }
    expect(render('beta')).not.toContain('>Usage<')
    expect(render('beta', null, null, { codex: [] })).not.toContain('>Usage<')
    expect(render('beta', null, null, { claude: [meter] })).toMatch(
      />Usage<.*>Stats</,
    )
  })

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

  it('shows an error only while there is one', () => {
    expect(render('beta')).not.toContain('navbar-error')
    expect(render('beta', null, '502 Bad Gateway')).toMatch(
      /class="navbar-error"[^>]*>502 Bad Gateway</,
    )
  })
})
