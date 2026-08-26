import { describe, expect, it } from 'vitest'
import { planTurnActions } from './turnActions'
import { planTurnCollapse } from './turnCollapse'
import type { TaskActionItem } from './types'

const T = (clock: string) => `2026-06-26T${clock}.000Z`

const prose = (at: string, text = 'some prose') => ({
  kind: 'message' as const,
  at,
  text,
})
const tool = (at: string) => ({ kind: 'tool' as const, at })
const action = (id: string, at: string): TaskActionItem => ({
  id,
  at,
  kind: 'task-action',
  action: 'launch',
  target: { id: 'child', projectSlug: 'proj' },
})

// The trace as the planner sees it, with every index on the main thread.
const plan = (
  items: (ReturnType<typeof prose> | ReturnType<typeof tool>)[],
  actions: TaskActionItem[],
) => {
  const mainIdxs = items.map((_, i) => i)
  return planTurnActions(
    items,
    mainIdxs,
    actions,
    planTurnCollapse(items, mainIdxs),
  )
}

describe('planTurnActions', () => {
  it('anchors an action before the next prose section, not the next item', () => {
    // launch at :02 — the tool at :03 is not a narrative beat, the prose at
    // :04 is, so the note leads that paragraph.
    const items = [
      prose(T('10:00:01')),
      tool(T('10:00:03')),
      prose(T('10:00:04')),
    ]
    const { before, tail } = plan(items, [action('a1', T('10:00:02'))])
    expect([...before.keys()]).toEqual([2])
    expect(before.get(2)?.map((a) => a.id)).toEqual(['a1'])
    expect(tail).toEqual([])
  })

  it('treats a run of adjacent messages as one section, anchoring at its head', () => {
    // A provider that emits a paragraph per message (Codex) writes one answer
    // as several items; an action before it precedes the answer, not paragraph
    // two.
    const items = [
      tool(T('10:00:01')),
      prose(T('10:00:03')),
      prose(T('10:00:04')),
    ]
    const { before } = plan(items, [action('a1', T('10:00:02'))])
    expect([...before.keys()]).toEqual([1])
  })

  it('gathers everything done between two beats at one anchor, in order', () => {
    const items = [prose(T('10:00:01')), tool(T('10:00:02')), prose(T('10:00:09'))]
    const { before } = plan(items, [
      action('a1', T('10:00:03')),
      action('a2', T('10:00:04')),
      action('a3', T('10:00:05')),
    ])
    expect(before.get(2)?.map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('skips prose the fold hides, surfacing the note below the folded stretch', () => {
    // planTurnCollapse keeps the opening, the longest sequence, and the last;
    // the short middle prose is hidden. An action taken during the hidden
    // stretch anchors at the next KEPT prose instead, where it can be read
    // without opening the fold.
    const items = [
      prose(T('10:00:01'), 'opening'),
      tool(T('10:00:02')),
      prose(T('10:00:04'), 'mid'),
      tool(T('10:00:05')),
      prose(T('10:00:09'), 'closing-'.repeat(10)),
    ]
    const collapse = planTurnCollapse(
      items,
      items.map((_, i) => i),
    )
    expect(collapse.segments.some((s) => s.hidden)).toBe(true)
    const { before } = plan(items, [action('a1', T('10:00:03'))])
    expect([...before.keys()]).toEqual([4])
  })

  it('falls to the tail when no prose follows, and on a turn with none at all', () => {
    const trailing = plan(
      [prose(T('10:00:01')), tool(T('10:00:02'))],
      [action('a1', T('10:00:03'))],
    )
    expect(trailing.before.size).toBe(0)
    expect(trailing.tail.map((a) => a.id)).toEqual(['a1'])

    const wordless = plan([tool(T('10:00:01'))], [action('a1', T('10:00:02'))])
    expect(wordless.tail.map((a) => a.id)).toEqual(['a1'])
  })

  it('anchors an action older than the whole turn at its first prose', () => {
    // The record can be stored before the turn's first batch is applied.
    const items = [tool(T('10:00:05')), prose(T('10:00:06'))]
    const { before } = plan(items, [action('a1', T('10:00:00'))])
    expect([...before.keys()]).toEqual([1])
  })
})
