import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EmbedPane } from './embed'
import type { TaskWithProject } from './types'

const task = {
  id: 't1',
  projectSlug: 'proj',
  title: 'Fix the banner',
  status: 'wedged',
  createdAt: '2026-11-10T00:00:00.000Z',
  items: [],
} as unknown as TaskWithProject

const html = (props: { task: TaskWithProject | null; error: string | null }) =>
  renderToStaticMarkup(<EmbedPane {...props}>the conversation</EmbedPane>)

describe('EmbedPane', () => {
  it('shows loading until the task arrives', () => {
    const pane = html({ task: null, error: null })
    expect(pane).toContain('Loading…')
    expect(pane).not.toContain('the conversation')
  })

  it('shows why a task could not be loaded, without claiming to be loading', () => {
    const pane = html({ task: null, error: 'task not found' })
    expect(pane).toContain('task not found')
    expect(pane).not.toContain('Loading…')
  })

  it('shows the conversation under a link to the task in full lander, with its status', () => {
    const pane = html({ task, error: null })
    expect(pane).toContain('href="/proj/t1"')
    expect(pane).toContain('Fix the banner')
    expect(pane).toContain('task-status wedged')
    expect(pane).toContain('the conversation')
  })

  it('keeps the conversation on screen when a later poll fails', () => {
    const pane = html({ task, error: 'server restarting' })
    expect(pane).toContain('server restarting')
    expect(pane).toContain('the conversation')
  })
})
