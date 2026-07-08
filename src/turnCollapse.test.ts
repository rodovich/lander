import { describe, expect, it } from 'vitest'
import { planTurnCollapse } from './turnCollapse'

type TestStep = {
  kind: 'text' | 'tool_use' | 'tool_result'
  text?: string
}

const text = (value: string): TestStep => ({ kind: 'text', text: value })
const tool = (): TestStep => ({ kind: 'tool_use' })
const result = (): TestStep => ({ kind: 'tool_result' })

const plan = (steps: TestStep[], indices?: number[]) =>
  planTurnCollapse(steps, indices)

describe('planTurnCollapse', () => {
  it('keeps opening text before tools and collapses the range before the longest sequence', () => {
    const steps = [
      text('intro'),
      tool(),
      result(),
      text('progress update'),
      tool(),
      text('the longest final assistant message'),
      tool(),
    ]

    expect(plan(steps)).toEqual({
      segments: [
        { hidden: false, indices: [0] },
        { hidden: true, indices: [1, 2, 3, 4] },
        { hidden: false, indices: [5, 6] },
      ],
    })
  })

  it('groups adjacent text steps into one sequence and folds the middle and the tail before the last', () => {
    const steps = [
      text('opening paragraph one'),
      text('opening paragraph two — the longest concatenated sequence overall'),
      tool(),
      result(),
      text('a progress note in the middle'),
      tool(),
      text('closing line'),
    ]

    // Steps 0 and 1 form the opening sequence (also the longest); the middle
    // tools and the stray progress text fold; the last sequence stays open.
    expect(plan(steps)).toEqual({
      segments: [
        { hidden: false, indices: [0, 1] },
        { hidden: true, indices: [2, 3, 4, 5] },
        { hidden: false, indices: [6] },
      ],
    })
  })

  it('folds separately between the opening, longest, and last sequences', () => {
    const steps = [
      text('intro'),
      tool(),
      text('the substantially longer longest assistant message here'),
      tool(),
      text('mid'),
      tool(),
      text('final'),
    ]

    expect(plan(steps)).toEqual({
      segments: [
        { hidden: false, indices: [0] },
        { hidden: true, indices: [1] },
        { hidden: false, indices: [2] },
        { hidden: true, indices: [3, 4, 5] },
        { hidden: false, indices: [6] },
      ],
    })
  })

  it('does not preserve a first text message that follows tool calls', () => {
    const steps = [
      tool(),
      result(),
      text('short progress'),
      tool(),
      text('substantially longer final answer'),
    ]

    expect(plan(steps)).toEqual({
      segments: [
        { hidden: true, indices: [0, 1, 2, 3] },
        { hidden: false, indices: [4] },
      ],
    })
  })

  it('shows an uninterrupted text-only trace in full', () => {
    const steps = [
      text('intro'),
      text('middle progress'),
      text('the longest final assistant message'),
    ]

    // No tools split the run, so it is a single sequence — nothing to fold.
    expect(plan(steps)).toEqual({
      segments: [{ hidden: false, indices: [0, 1, 2] }],
    })
  })

  it('does not fold when there is no hidden range before the longest text', () => {
    const steps = [text('long final answer'), tool(), result()]

    expect(plan(steps)).toEqual({
      segments: [{ hidden: false, indices: [0, 1, 2] }],
    })
  })

  it('ignores steps outside the supplied main trace indices', () => {
    const steps = [
      text('intro'),
      text('nested subagent text that should not drive the main collapse'),
      tool(),
      text('final answer'),
    ]

    expect(plan(steps, [0, 2, 3])).toEqual({
      segments: [
        { hidden: false, indices: [0] },
        { hidden: true, indices: [2] },
        { hidden: false, indices: [3] },
      ],
    })
  })

  it('does not fold a trace without text messages', () => {
    const steps = [tool(), result(), tool()]

    expect(plan(steps)).toEqual({
      segments: [{ hidden: false, indices: [0, 1, 2] }],
    })
  })
})
