import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { DetailHeader } from './detailHeader'
import type { TaskWithProject } from './types'

const AT = '2026-06-26T10:00:00.000Z'

const baseTask = (over: Partial<TaskWithProject> = {}): TaskWithProject => ({
  id: 'task1',
  agent: 'claude',
  title: 'Fix the parser',
  status: 'paced',
  createdAt: AT,
  allowEdits: true,
  projectSlug: 'proj',
  items: [],
  rides: [],
  ...over,
})

const render = (
  task: TaskWithProject,
  over: Partial<ComponentProps<typeof DetailHeader>> = {},
) =>
  renderToStaticMarkup(
    <DetailHeader
      task={task}
      projectLabel={null}
      retitling={null}
      copyMarkdown={() => ''}
      onTaskAction={() => {}}
      saveTitle={async () => {}}
      generateTitle={async () => {}}
      allowTool={async () => true}
      setAllowEdits={async () => {}}
      {...over}
    />,
  )

describe('DetailHeader', () => {
  it('renders the title, status, and the project label only when given', () => {
    const html = render(baseTask({ status: 'wedged' }), {
      projectLabel: 'proj • wt-fix',
    })
    expect(html).toContain('Fix the parser')
    expect(html).toContain('task-status wedged')
    expect(html).toContain('proj • wt-fix')
    expect(render(baseTask())).not.toContain('detail-project')
  })

  it('carries both copy buttons — the task id and the conversation', () => {
    const html = render(baseTask())
    expect(html).toContain('Copy task ID')
    expect(html).toContain('Copy conversation as markdown')
    expect(html).toContain('copy-conversation')
  })

  it('hides the grant and read-only controls on an archived task', () => {
    const active = render(baseTask({ allowEdits: false }))
    expect(active).toContain('Read-only')
    const archived = render(baseTask({ allowEdits: false, archived: true }))
    expect(archived).not.toContain('Read-only')
  })

  // The sparkle holds still while haiku is naming *this* task; another task's
  // naming leaves it live.
  it('disables the naming sparkle only for the task being retitled', () => {
    expect(render(baseTask(), { retitling: 'proj/task1' })).toContain(
      'aria-label="Regenerate title" disabled=""',
    )
    expect(render(baseTask(), { retitling: 'proj/other' })).not.toContain(
      'disabled=""',
    )
  })
})
