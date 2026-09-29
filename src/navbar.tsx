import { memo } from 'react'
import { TIME_FILTER_LABELS, VIEW_LABELS, lastPathComponent } from './format'
import { SegmentedControl } from './segmentedControl'
import type { Project, TaskView, TimeFilter } from './types'

// The page title: the open project's leaf, then the time filter and view when
// they aren't the defaults ("lander • Today • Unread").
export function pageTitle(
  projectPath: string | undefined,
  timeFilter: TimeFilter,
  view: TaskView,
): string {
  const parts = [
    projectPath ? lastPathComponent(projectPath) : '',
    timeFilter === 'any' ? '' : TIME_FILTER_LABELS[timeFilter],
    view === 'inbox' ? '' : VIEW_LABELS[view],
  ].filter(Boolean)
  return parts.length ? parts.join(' • ') : 'lander'
}

// The bar across the top of the page: the brand, the project switcher, and the
// project's hooks.
export const Navbar = memo(function Navbar({
  projects,
  project,
  setProject,
  hooksOpen,
  onToggleHooks,
}: {
  projects: Project[]
  project: string
  setProject: (slug: string) => void
  hooksOpen: boolean
  onToggleHooks: () => void
}) {
  return (
    <nav className="navbar">
      <div className="navbar-start">
        <div className="navbar-brand">
          <img src="/favicon.svg" alt="" width={20} height={20} />
          lander
        </div>
        {projects.length > 0 && (
          <SegmentedControl
            label="Project"
            value={project}
            onChange={setProject}
            options={projects.map((p) => ({
              value: p.slug,
              label: lastPathComponent(p.path),
              title: p.path,
            }))}
          />
        )}
      </div>
      {project && (
        <button
          type="button"
          className={'navbar-button' + (hooksOpen ? ' active' : '')}
          aria-pressed={hooksOpen}
          onClick={onToggleHooks}
        >
          Hooks
        </button>
      )}
    </nav>
  )
})
