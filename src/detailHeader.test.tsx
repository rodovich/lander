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
      grants={{ task: true, project: true }}
      retitling={null}
      copyMarkdown={() => ''}
      onTaskAction={() => {}}
      saveTitle={async () => {}}
      generateTitle={async () => {}}
      allowTool={async () => true}
      onRetry={async () => true}
      {...over}
    />,
  )

describe('DetailHeader', () => {
  it('renders the title, status, and the worktree chip only for a task with a worktree', () => {
    const html = render(
      baseTask({
        status: 'wedged',
        checkout: {
          path: '/p/.worktrees/task1',
          branch: 'fix-parser',
          files: [
            { path: 'src/a.ts', added: 3, removed: 1 },
            { path: 'logo.png', added: null, removed: null },
          ],
        },
      }),
    )
    expect(html).toContain('Fix the parser')
    expect(html).toContain('task-status wedged')
    expect(html).toContain('fix-parser')
    expect(html).toContain('2 files')
    expect(html).toContain('+3')
    expect(html).toContain('−1')
    expect(render(baseTask())).not.toContain('checkout-chip')
  })

  it('names a detached worktree, and counts nothing when nothing changed', () => {
    const html = render(baseTask({ checkout: { path: '/p/.worktrees/task1', files: [] } }))
    expect(html).toContain('detached')
    expect(html).not.toMatch(/\d files?</)
    expect(html).not.toContain('diffstat')
  })

  it('carries both copy buttons — the task id and the conversation', () => {
    const html = render(baseTask())
    expect(html).toContain('Copy task ID')
    expect(html).toContain('Copy conversation as markdown')
    expect(html).toContain('copy-conversation')
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
