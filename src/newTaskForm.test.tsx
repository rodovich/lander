import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { NewTaskForm } from './newTaskForm'
import type { FlowMeta } from './types'

function flow(name: string, driver = true): FlowMeta {
  return {
    api: 1,
    name,
    description: `the ${name} flow`,
    driver,
    capabilities: {
      grants: { task: false, project: false },
      usageSnapshot: false,
      rateLimitRetry: false,
      reportsCost: false,
    },
  }
}

describe('NewTaskForm', () => {
  let store: Map<string, string>

  beforeEach(() => {
    store = new Map()
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const render = (flows: FlowMeta[]) =>
    renderToStaticMarkup(
      <NewTaskForm
        targetSlug="proj"
        flows={flows}
        height={200}
        setError={() => {}}
        admit={() => {}}
        onCreated={() => {}}
      />,
    )

  it('waits for the daemon and disables launching when no driver flows are announced', () => {
    store.set('lander:draft:newTask', JSON.stringify('a task prompt'))
    const html = render([flow('helper', false)])
    expect(html).toContain('<select class="new-task-agent" disabled="">')
    expect(html).toContain('<option value="" selected="">Waiting for daemon…</option>')
    expect(html).toContain('<button type="submit" class="launch-btn" disabled="">Launch</button>')
  })

  it('lists every announced driver flow and defaults to the first when the saved pick is absent', () => {
    store.set('lander:draft:newTask', JSON.stringify('a task prompt'))
    store.set('lander:draft:newFlow', JSON.stringify('retired'))
    const html = render([flow('claude'), flow('codex'), flow('agy'), flow('helper', false)])
    expect(html).toContain('<option value="claude" title="the claude flow" selected="">Claude</option>')
    expect(html).toContain('<option value="codex" title="the codex flow">Codex</option>')
    expect(html).toContain('<option value="agy" title="the agy flow">Antigravity</option>')
    expect(html).not.toContain('helper')
    expect(html).toContain('<button type="submit" class="launch-btn">Launch</button>')
  })

  it('keeps the saved flow when the daemon announces it', () => {
    store.set('lander:draft:newFlow', JSON.stringify('agy'))
    const html = render([flow('claude'), flow('codex'), flow('agy')])
    expect(html).toContain('<option value="agy" title="the agy flow" selected="">Antigravity</option>')
  })
})
