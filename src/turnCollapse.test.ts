import { describe, expect, it } from 'vitest'
import { planTurnCollapse } from './turnCollapse'

// The collapse reads a ride's main-thread items: flow `message` items carry the
// prose it folds by, `tool` items are the separators between text sequences.
type TestItem = {
  kind: 'message' | 'tool' | 'event' | 'ask'
  text?: string
}

const text = (value: string): TestItem => ({ kind: 'message', text: value })
const tool = (): TestItem => ({ kind: 'tool' })

const plan = (items: TestItem[], indices?: number[]) =>
  planTurnCollapse(items, indices)

describe('planTurnCollapse', () => {
  it('keeps opening text before tools and collapses the range before the longest sequence', () => {
    const items = [
      text('intro'),
      tool(),
      text('progress update'),
      tool(),
      text('the longest final assistant message'),
      tool(),
    ]

    expect(plan(items)).toEqual({
      segments: [
        { hidden: false, indices: [0] },
        { hidden: true, indices: [1, 2, 3] },
        { hidden: false, indices: [4, 5] },
      ],
    })
  })

  it('groups adjacent flow messages into one sequence and folds the middle and the tail before the last', () => {
    const items = [
      text('opening paragraph one'),
      text('opening paragraph two — the longest concatenated sequence overall'),
      tool(),
      text('a progress note in the middle'),
      tool(),
      text('closing line'),
    ]

    // Items 0 and 1 form the opening sequence (also the longest); the middle
    // tool and the stray progress text fold; the last sequence stays open.
    expect(plan(items)).toEqual({
      segments: [
        { hidden: false, indices: [0, 1] },
        { hidden: true, indices: [2, 3, 4] },
        { hidden: false, indices: [5] },
      ],
    })
  })

  it('folds separately between the opening, longest, and last sequences', () => {
    const items = [
      text('intro'),
      tool(),
      text('the substantially longer longest assistant message here'),
      tool(),
      text('mid'),
      tool(),
      text('final'),
    ]

    expect(plan(items)).toEqual({
      segments: [
        { hidden: false, indices: [0] },
        { hidden: true, indices: [1] },
        { hidden: false, indices: [2] },
        { hidden: true, indices: [3, 4, 5] },
        { hidden: false, indices: [6] },
      ],
    })
  })

  it('does not preserve a first message that follows tool calls', () => {
    const items = [
      tool(),
      text('short progress'),
      tool(),
      text('substantially longer final answer'),
    ]

    expect(plan(items)).toEqual({
      segments: [
        { hidden: true, indices: [0, 1, 2] },
        { hidden: false, indices: [3] },
      ],
    })
  })

  it('shows an uninterrupted text-only trace in full', () => {
    const items = [
      text('intro'),
      text('middle progress'),
      text('the longest final assistant message'),
    ]

    // No tools split the run, so it is a single sequence — nothing to fold.
    expect(plan(items)).toEqual({
      segments: [{ hidden: false, indices: [0, 1, 2] }],
    })
  })

  it('does not fold when there is no hidden range before the longest text', () => {
    const items = [text('long final answer'), tool()]

    expect(plan(items)).toEqual({
      segments: [{ hidden: false, indices: [0, 1] }],
    })
  })

  it('ignores items outside the supplied main-thread indices', () => {
    const items = [
      text('intro'),
      text('nested subagent text that should not drive the main collapse'),
      tool(),
      text('final answer'),
    ]

    expect(plan(items, [0, 2, 3])).toEqual({
      segments: [
        { hidden: false, indices: [0] },
        { hidden: true, indices: [2] },
        { hidden: false, indices: [3] },
      ],
    })
  })

  it('does not fold a trace without flow messages', () => {
    const items = [tool(), tool()]

    expect(plan(items)).toEqual({
      segments: [{ hidden: false, indices: [0, 1] }],
    })
  })
})
