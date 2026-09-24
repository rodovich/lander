import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { UsageReadout } from './usageReadout'
import type { Ride, Task } from './types'

// The static (effect-free) markup, which is the readout at rest: the summary
// line, with the breakdown closed. What the panel says once it opens is
// `usageBreakdown`'s doing and is tested there; opening it is a pointer gesture
// no static render performs.
const render = (rides: Ride[], over: Partial<Task> = {}) =>
  renderToStaticMarkup(
    <UsageReadout
      task={
        {
          id: 't',
          title: 'T',
          status: 'paced',
          createdAt: '2026-09-09T00:00:00.000Z',
          allowEdits: false,
          items: [],
          rides,
          ...over,
        } as Task
      }
    />,
  )

const ride = (over: Partial<Ride>): Ride => ({
  id: 'r1',
  startedAt: '2026-09-09T11:00:00.000Z',
  endedAt: '2026-09-09T11:01:23.000Z',
  usage: { input: 100, output: 40, cacheRead: 3_000, cacheCreation: 20 },
  ...over,
})

describe('UsageReadout', () => {
  it('summarizes the task as provider & model, time, and cost', () => {
    const priced = ride({
      durationMs: 83_000,
      usage: {
        input: 100,
        output: 40,
        cacheRead: 3_000,
        cacheCreation: 20,
        model: 'claude-opus-5',
        costUsd: 0.75,
      },
    })
    const html = render([priced], { flow: 'claude' })
    expect(html).toContain('Claude (claude-opus-5)')
    expect(html).toContain('1m 23s')
    expect(html).toContain('$0.75')
  })

  it('carries no token counts — those are the breakdown’s business', () => {
    const html = render([ride({ durationMs: 83_000 })])
    expect(html).not.toContain('3,000')
    expect(html).not.toContain('3k')
  })

  it('holds the breakdown closed until it is hovered or tapped', () => {
    const html = render([ride({ durationMs: 83_000 })])
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('usage-table')
  })

  it('names the provider through a turn that has reported no usage yet', () => {
    const html = render([{ id: 'r1', startedAt: '2026-09-09T11:00:00.000Z' }], {
      flow: 'codex',
    })
    expect(html).toContain('Codex')
    // Nothing measured, so nothing else is claimed — and the breakdown behind it
    // is still there to be opened, saying the same in its cells.
    expect(html).not.toContain('$')
    expect(html).toContain('aria-expanded="false"')
  })
})
