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
  it('keeps opening text before tools and collapses the flat range before the longest text', () => {
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
      visibleBefore: [0],
      hidden: [1, 2, 3, 4],
      visibleAfter: [5, 6],
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
      visibleBefore: [],
      hidden: [0, 1, 2, 3],
      visibleAfter: [4],
    })
  })

  it('keeps the opening text in text-only traces', () => {
    const steps = [
      text('intro'),
      text('middle progress'),
      text('the longest final assistant message'),
    ]

    expect(plan(steps)).toEqual({
      visibleBefore: [0],
      hidden: [1],
      visibleAfter: [2],
    })
  })

  it('does not fold when there is no hidden range before the longest text', () => {
    const steps = [text('long final answer'), tool(), result()]

    expect(plan(steps)).toEqual({
      visibleBefore: [],
      hidden: [],
      visibleAfter: [0, 1, 2],
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
      visibleBefore: [0],
      hidden: [2],
      visibleAfter: [3],
    })
  })

  it('does not fold a trace without text messages', () => {
    const steps = [tool(), result(), tool()]

    expect(plan(steps)).toEqual({
      visibleBefore: [],
      hidden: [],
      visibleAfter: [0, 1, 2],
    })
  })
})
