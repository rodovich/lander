import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectMenu, filterLabelParts } from './projectMenu'
import type { Project } from './types'

const P = (path: string): Project => ({
  path,
  slug: path.split('/').pop() ?? path,
})
const THREE = [P('/code/alpha'), P('/code/beta'), P('/code/gamma')]
const ALL = THREE.map((p) => p.slug)

const parts = (
  projects: Project[],
  shown: string[],
  timeFilter: Parameters<typeof filterLabelParts>[2] = 'any',
  view: Parameters<typeof filterLabelParts>[3] = 'inbox',
) => filterLabelParts(projects, shown, timeFilter, view)

describe('filterLabelParts base', () => {
  it('is empty before the project list loads', () => {
    expect(parts([], []).base).toBe('')
  })

  it('reads "All projects" only when several projects are all shown', () => {
    expect(parts(THREE, ALL).base).toBe('All projects')
    // A single project shown-in-full names itself instead.
    expect(parts([P('/code/alpha')], ['alpha']).base).toBe('alpha')
  })

  it('names a single shown project by its path leaf, falling back to the slug', () => {
    expect(parts(THREE, ['beta']).base).toBe('beta')
    expect(parts(THREE, ['ghost']).base).toBe('ghost')
  })

  it('counts a partial selection as "N of M"', () => {
    expect(parts(THREE, ['alpha', 'beta']).base).toBe('2 of 3')
  })
})

describe('filterLabelParts suffixes', () => {
  it('appends the active time filter, skipping the "any" default', () => {
    expect(parts(THREE, ALL, 'today').suffixes).toEqual(['Today'])
    expect(parts(THREE, ALL, 'week').suffixes).toEqual(['This week'])
    expect(parts(THREE, ALL, 'older').suffixes).toEqual(['Older'])
    expect(parts(THREE, ALL, 'any').suffixes).toEqual([])
  })

  it('appends the non-default views, time first', () => {
    expect(parts(THREE, ALL, 'any', 'unread').suffixes).toEqual(['Unread'])
    expect(parts(THREE, ALL, 'any', 'archived').suffixes).toEqual(['Archived'])
    expect(parts(THREE, ALL, 'any', 'inbox').suffixes).toEqual([])
    expect(parts(THREE, ALL, 'today', 'unread').suffixes).toEqual([
      'Today',
      'Unread',
    ])
  })
})

describe('ProjectMenu closed button', () => {
  it('summarizes the selection with its suffixes, menu closed', () => {
    const html = renderToStaticMarkup(
      <ProjectMenu
        projects={THREE}
        shown={['alpha']}
        setShown={() => {}}
        view="unread"
        setView={() => {}}
        timeFilter="today"
        setTimeFilter={() => {}}
        onPickProject={() => {}}
        onOpenHooks={() => {}}
      />,
    )
    expect(html).toContain('project-select-name')
    expect(html).toContain('alpha')
    expect(html).toContain('Today')
    expect(html).toContain('Unread')
    // Closed by default: no menu items in the initial markup.
    expect(html).not.toContain('project-menu-item')
  })
})
