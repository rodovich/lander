import { memo, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { lastPathComponent } from './format'
import type { Project, TaskView, TimeFilter } from './types'

// The parts of the dropdown's summary label, shared with the page title:
// "All projects" when every project is shown, otherwise the single shown
// project's leaf (just the last path segment — the menu items still show full
// paths). The active time filter ("Today"/"This week", not "Any time") and the
// non-default views ("Unread"/"Archived", not the "Inbox" default) each append
// a "• …" suffix, in that order (e.g. "All projects • Today • Unread").
export function filterLabelParts(
  projects: Project[],
  shown: string[],
  timeFilter: TimeFilter,
  view: TaskView,
): { base: string; suffixes: string[] } {
  const pathBySlug = new Map(projects.map((p) => [p.slug, p.path]))
  const allShown = projects.length > 0 && shown.length === projects.length
  const base =
    projects.length === 0
      ? ''
      : allShown && projects.length > 1
        ? 'All projects'
        : shown.length === 1
          ? lastPathComponent(pathBySlug.get(shown[0]) ?? shown[0])
          : `${shown.length} of ${projects.length}`
  const timeLabel =
    timeFilter === 'today'
      ? 'Today'
      : timeFilter === 'week'
        ? 'This week'
        : timeFilter === 'older'
          ? 'Older'
          : ''
  const viewLabel =
    view === 'unread' ? 'Unread' : view === 'archived' ? 'Archived' : ''
  return { base, suffixes: [timeLabel, viewLabel].filter(Boolean) }
}

// The sidebar's filter dropdown: project picks, the time-window radios, and
// the view radios, summarized on the closed button. Owns its open/close state.
export const ProjectMenu = memo(function ProjectMenu({
  projects,
  shown,
  setShown,
  view,
  setView,
  timeFilter,
  setTimeFilter,
  onPickProject,
  onOpenHooks,
}: {
  projects: Project[]
  shown: string[]
  setShown: Dispatch<SetStateAction<string[]>>
  view: TaskView
  setView: Dispatch<SetStateAction<TaskView>>
  timeFilter: TimeFilter
  setTimeFilter: Dispatch<SetStateAction<TimeFilter>>
  // Fired when a single project is picked, so the new-task form can follow it.
  onPickProject: (slug: string) => void
  // Opens the project's hook settings in the detail pane. Here because this is
  // the only project-scoped control in the UI; the panel picks the project.
  onOpenHooks: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const allShown = projects.length > 0 && shown.length === projects.length
  const { base, suffixes } = filterLabelParts(projects, shown, timeFilter, view)

  // Clicking a project shows only that project — unless it was already the only
  // one shown, in which case it expands back to all projects.
  function showOnly(slug: string) {
    if (shown.length === 1 && shown[0] === slug) {
      setShown(projects.map((p) => p.slug))
    } else {
      setShown([slug])
      // Picking a specific project also targets new tasks at it. Showing all
      // projects or changing the time/status filter leaves this untouched.
      onPickProject(slug)
    }
    setMenuOpen(false)
  }

  function showAll() {
    setShown(projects.map((p) => p.slug))
    setMenuOpen(false)
  }

  // Close the project menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  return (
    <div className="project-filter" ref={menuRef}>
      <button
        type="button"
        className="project-select"
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
        <span className="project-select-label">
          {base && <span className="project-select-name">{base}</span>}
          {suffixes.map((s) => (
            <span key={s} className="project-select-suffix">
              {' • '}
              {s}
            </span>
          ))}
        </span>
        <svg
          className="project-select-caret"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden
        >
          <path
            d="m6 9 6 6 6-6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {menuOpen && (
        <div className="project-menu" role="listbox">
          {projects.map((p) => (
            <button
              key={p.slug}
              type="button"
              role="option"
              aria-selected={shown.includes(p.slug)}
              className="project-menu-item"
              onClick={() => showOnly(p.slug)}
            >
              <span className="project-menu-check">
                {shown.includes(p.slug) ? '✓' : ''}
              </span>
              <span className="project-menu-path">{p.path}</span>
            </button>
          ))}
          <button
            type="button"
            className="project-menu-item project-menu-all"
            onClick={showAll}
          >
            <span className="project-menu-check">{allShown ? '✓' : ''}</span>
            <span className="project-menu-path">All projects</span>
          </button>
          {(
            [
              ['today', 'Today'],
              ['week', 'This week'],
              ['older', 'Older'],
              ['any', 'Any time'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="project-menu-item project-menu-time"
              role="menuitemradio"
              aria-checked={timeFilter === value}
              onClick={() => {
                setTimeFilter(value)
                setMenuOpen(false)
              }}
            >
              <span className="project-menu-check">
                {timeFilter === value ? '✓' : ''}
              </span>
              <span className="project-menu-path">{label}</span>
            </button>
          ))}
          {(
            [
              ['inbox', 'Inbox'],
              ['unread', 'Unread'],
              ['archived', 'Archived'],
            ] as const
          ).map(([value, label], i) => (
            <button
              key={value}
              type="button"
              className={
                'project-menu-item project-menu-view' +
                (i === 0 ? ' project-menu-view-first' : '')
              }
              role="menuitemradio"
              aria-checked={view === value}
              onClick={() => {
                setView(value)
                setMenuOpen(false)
              }}
            >
              <span className="project-menu-check">
                {view === value ? '✓' : ''}
              </span>
              <span className="project-menu-path">{label}</span>
            </button>
          ))}
          <button
            type="button"
            className="project-menu-item project-menu-view project-menu-view-first"
            onClick={() => {
              onOpenHooks()
              setMenuOpen(false)
            }}
          >
            <span className="project-menu-check" />
            <span className="project-menu-path">Hooks…</span>
          </button>
        </div>
      )}
    </div>
  )
})
