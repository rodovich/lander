import { expect, it } from 'vitest'
import { makeFlow } from './claude'
import { driveFlow, goldenInput, type Golden } from './testCtx'
import { applyEvents } from './testTask'

it('carries Claude progress-only batches and completion markers through the runtime and task fold', async () => {
  const j = JSON.stringify
  const g: Golden = {
    name: 'Claude compaction',
    chunks: [
      [j({ type: 'system', subtype: 'init' })],
      [j({ type: 'system', subtype: 'status', status: 'compacting' })],
      [j({ type: 'system', subtype: 'compact_boundary', compact_metadata: {
        trigger: 'manual', pre_tokens: 182000, post_tokens: 24000, duration_ms: 1250,
      } })],
      [j({ type: 'assistant', message: { id: 'msg-after', content: [{ type: 'text', text: 'After compaction' }] } })],
      [j({ type: 'result', result: 'After compaction' })],
    ],
  }
  const driven = await driveFlow(g, makeFlow({
    landerBin: '/repo/bin/lander', taskPromptTemplate: '',
    readProjectDoc: () => undefined, gitContext: () => '', mint: () => 'session',
  }))
  const progressAt = driven.events.findIndex((e) => e.kind === 'update' && e.steps.some((s) => s.context?.phase === 'started'))
  expect(progressAt).toBeGreaterThan(-1)
  const mid = applyEvents(goldenInput(g).start, driven.events.slice(0, progressAt + 1))
  expect(mid.rides).toEqual([expect.objectContaining({ compacting: true })])
  expect(mid.items).toEqual([])
  const task = applyEvents(goldenInput(g).start, driven.events)
  expect(task.items).toEqual([
    expect.objectContaining({ kind: 'context', action: 'compaction',
      trigger: 'manual', beforeTokens: 182000, afterTokens: 24000, durationMs: 1250 }),
    expect.objectContaining({ kind: 'message', text: 'After compaction' }),
  ])
  expect(task.rides).toEqual([expect.not.objectContaining({ compacting: true })])
  expect(driven.result.exitCode).toBe(0)
})
