import { memo } from 'react'
import {
  DEFAULT_TIME_FILTER,
  DEFAULT_VIEW,
  TIME_FILTER_LABELS,
  VIEW_LABELS,
  lastPathComponent,
} from './format'
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
    timeFilter === DEFAULT_TIME_FILTER ? '' : TIME_FILTER_LABELS[timeFilter],
    view === DEFAULT_VIEW ? '' : VIEW_LABELS[view],
  ].filter(Boolean)
  return parts.length ? parts.join(' • ') : 'lander'
}

// The panels the navbar's buttons open in the detail pane, in place of a task.
export type Panel = 'stats' | 'hooks'

const PANEL_LABELS: Record<Panel, string> = { stats: 'Stats', hooks: 'Hooks' }

// The bar across the top of the page: the brand, the project switcher, the
// app-wide error if there is one, and the project's stats and hooks.
export const Navbar = memo(function Navbar({
  projects,
  project,
  setProject,
  panel,
  onTogglePanel,
  error,
}: {
  projects: Project[]
  project: string
  setProject: (slug: string) => void
  panel: Panel | null
  onTogglePanel: (panel: Panel) => void
  error: string | null
}) {
  return (
    <nav className="navbar">
      <div className="navbar-start">
        <img className="navbar-brand" src="/wordmark.svg" alt="lander" height={20} />
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
        {error && (
          <div className="navbar-error" role="alert" title={error}>
            {error}
          </div>
        )}
      </div>
      {project && (
        <div className="navbar-actions">
          {(['stats', 'hooks'] as const).map((name) => (
            <button
              key={name}
              type="button"
              className={'action-button' + (panel === name ? ' active' : '')}
              aria-pressed={panel === name}
              onClick={() => onTogglePanel(name)}
            >
              {PANEL_LABELS[name]}
            </button>
          ))}
        </div>
      )}
    </nav>
  )
})
