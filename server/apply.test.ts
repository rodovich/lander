import { describe, it, expect } from 'vitest'
import { applyUpdate, applyDone, type ApplyTask, type ApplyUpdate } from './apply'
import type { Step, Usage } from './stream'

const AT = '2026-01-01T00:00:00.000Z'

// A minimal riding task with a single user message and no pending assistant
// message yet — the state reduceRun seeds from before the first batch lands.
const task = (over: Partial<ApplyTask> = {}): ApplyTask => ({
  status: 'riding',
  title: 't',
  messages: [{ role: 'user', text: 'do it', createdAt: AT }],
  updatedAt: AT,
  runId: 'r1',
  runCursor: 0,
  ...over,
})

const step = (over: Partial<Step>): Step => ({
  kind: 'text',
  createdAt: AT,
  ...over,
})

// Defaults for the fields reduceRun resolves per batch; tests override.
const update = (over: Partial<ApplyUpdate>): ApplyUpdate => ({
  steps: [],
  usageChanged: false,
  cursor: 0,
  ...over,
})

describe('applyUpdate', () => {
  it('appends steps to the pending message, creating it on first batch', () => {
    const t = task()
    applyUpdate(t, update({ steps: [step({ text: 'hi' })], cursor: 10 }))
    const msg = t.messages[1]
    expect(msg.role).toBe('assistant')
    expect(msg.pending).toBe(true)
    expect(msg.steps).toEqual([step({ text: 'hi' })])
    // Begins the message, so updatedAt jumps to its createdAt and the cursor advances.
    expect(t.updatedAt).toBe(msg.createdAt)
    expect(t.runCursor).toBe(10)

    // A second batch appends rather than replacing, and does not re-bump updatedAt.
    const before = t.updatedAt
    applyUpdate(t, update({ steps: [step({ text: 'more' })], cursor: 20 }))
    expect(t.messages[1].steps).toEqual([step({ text: 'hi' }), step({ text: 'more' })])
    expect(t.updatedAt).toBe(before)
    expect(t.runCursor).toBe(20)
  })

  it('sets the running reply text from finalText', () => {
    const t = task()
    applyUpdate(t, update({ finalText: 'the answer', cursor: 5 }))
    expect(t.messages[1].text).toBe('the answer')
  })

  it('reconciles blocked tool_result steps via blockedIds across the whole message', () => {
    const t = task()
    // The tool_use/result stream in one batch; the blocked id arrives in a later one.
    applyUpdate(
      t,
      update({
        steps: [
          step({ kind: 'tool_use', tool: 'Bash', toolUseId: 'call_1' }),
          step({ kind: 'tool_result', toolUseId: 'call_1' }),
          step({ kind: 'tool_result', toolUseId: 'call_2' }),
        ],
        cursor: 1,
      }),
    )
    applyUpdate(t, update({ blockedIds: ['call_1'], cursor: 2 }))
    const steps = t.messages[1].steps!
    expect(steps.find((s) => s.toolUseId === 'call_1' && s.kind === 'tool_result')!.blocked).toBe(
      true,
    )
    expect(steps.find((s) => s.toolUseId === 'call_2')!.blocked).toBeUndefined()
  })

  it('sets usage with the driving model overriding the resolved usage model', () => {
    const t = task()
    const usage: Usage = {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheCreation: 4,
      model: 'sub-model',
    }
    applyUpdate(
      t,
      update({ usage, usageChanged: true, drivingModel: 'main-model', cursor: 3 }),
    )
    expect(t.messages[1].usage).toEqual({ ...usage, model: 'main-model' })
  })

  it('advances the cursor even when nothing else changed', () => {
    const t = task()
    applyUpdate(t, update({ cursor: 99 }))
    // No pending message created, no updatedAt bump — just the cursor.
    expect(t.messages).toHaveLength(1)
    expect(t.runCursor).toBe(99)
    expect(t.updatedAt).toBe(AT)
  })
})

describe('applyDone', () => {
  it('lands the pending message cleanly on a zero-exit finish', () => {
    const t = task()
    // A reply streamed first.
    applyUpdate(t, update({ steps: [step({ text: 'hello' })], finalText: 'hello', cursor: 1 }))
    const finishedAt = '2026-01-01T00:05:00.000Z'
    applyDone(t, { exitCode: 0, interrupted: false, stderr: '' }, { at: finishedAt })
    const msg = t.messages[1]
    expect(msg.pending).toBe(false)
    expect(msg.text).toBe('hello')
    expect(t.status).toBe('riding') // not wedged
    expect(t.retry).toBeUndefined()
    expect(t.updatedAt).toBe(finishedAt)
    expect('runId' in t).toBe(false)
    expect('runCursor' in t).toBe(false)
  })

  it('wedges and stashes a retry on a non-zero assistant error', () => {
    const t = task()
    const at = '2026-01-01T00:05:00.000Z'
    applyDone(
      t,
      { exitCode: 1, interrupted: false, stderr: 'boom' },
      { at, rateLimitResetsAt: '2026-01-01T01:00:00.000Z' },
    )
    const msg = t.messages[1]
    expect(msg.pending).toBe(false)
    expect(msg.text).toBe('error running assistant: exited 1\nboom')
    expect(t.status).toBe('wedged')
    // hadOutput is false (no reply streamed), so committed is false.
    expect(t.retry).toEqual({
      committed: false,
      prompts: ['do it'],
      resetsAt: '2026-01-01T01:00:00.000Z',
    })
    // The wedge crossing was recorded as a timeline event.
    expect(t.events?.some((e) => e.kind === 'wedged')).toBe(true)
  })

  it('marks committed true when a reply had begun before the error', () => {
    const t = task()
    applyUpdate(t, update({ steps: [step({ text: 'partial' })], finalText: 'partial', cursor: 1 }))
    applyDone(t, { exitCode: 1, interrupted: false, stderr: '' }, { at: AT })
    expect(t.status).toBe('wedged')
    expect(t.retry?.committed).toBe(true)
    // The partial reply text stands; it isn't overwritten by an error message.
    expect(t.messages[1].text).toBe('partial')
  })

  it('keeps an interrupted run unwedged and notes the stop when nothing streamed', () => {
    const t = task()
    applyDone(t, { exitCode: 137, interrupted: true, stderr: '' }, { at: AT })
    const msg = t.messages[1]
    expect(msg.pending).toBe(false)
    expect(msg.text).toBe('_(interrupted)_')
    expect(t.status).toBe('riding') // an interrupt is not an assistant error
    expect(t.retry).toBeUndefined()
  })
})
