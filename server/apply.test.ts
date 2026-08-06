import { describe, it, expect } from 'vitest'
import { applyUpdate, applyDone, type ApplyTask, type ApplyUpdate } from './apply'
import type { Step, Usage } from './stream'
import type { Item, MessageItem, ToolItem, Ride } from './tasks'

const AT = '2026-01-01T00:00:00.000Z'

// A minimal riding task with the opening user item and an open ride the run is
// streaming into (the state runTurn leaves before the first batch lands).
const task = (over: Partial<ApplyTask> = {}): ApplyTask => ({
  status: 'riding',
  title: 't',
  items: [{ id: 'u0', at: AT, kind: 'message', role: 'user', text: 'do it' }],
  rides: [{ id: 'r1', startedAt: AT }],
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

const update = (over: Partial<ApplyUpdate>): ApplyUpdate => ({
  steps: [],
  usageChanged: false,
  cursor: 0,
  ...over,
})

const rideItems = (t: ApplyTask, rideId = 'r1') =>
  (t.items ?? []).filter((it) => it.rideId === rideId)

describe('applyUpdate', () => {
  it('appends a flow item for a text step to the open ride, creating no message array', () => {
    const t = task()
    applyUpdate(t, update({ steps: [step({ text: 'hi' })], cursor: 10 }))
    const flow = rideItems(t)[0] as MessageItem
    expect(flow).toMatchObject({ kind: 'message', role: 'flow', text: 'hi', rideId: 'r1' })
    // Begins the ride, so updatedAt jumps to the first item's `at` and cursor advances.
    expect(t.updatedAt).toBe(AT)
    expect(t.runCursor).toBe(10)

    // A second batch appends rather than replacing, and does not re-bump updatedAt.
    const before = t.updatedAt
    applyUpdate(t, update({ steps: [step({ text: 'more', createdAt: '2026-01-01T00:01:00.000Z' })], cursor: 20 }))
    expect(rideItems(t).map((i) => (i.kind === 'message' ? i.text : ''))).toEqual(['hi', 'more'])
    expect(t.updatedAt).toBe(before)
    expect(t.runCursor).toBe(20)
  })

  it('folds a tool_use + tool_result into one tool item by id', () => {
    const t = task()
    applyUpdate(
      t,
      update({
        steps: [
          step({ kind: 'tool_use', tool: 'Bash', input: 'ls', toolUseId: 'call_1', rule: 'Bash(ls)' }),
          step({ kind: 'tool_result', toolUseId: 'call_1', text: 'a\nb' }),
        ],
        cursor: 1,
      }),
    )
    const tools = rideItems(t).filter((i) => i.kind === 'tool') as ToolItem[]
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      id: 'call_1',
      name: 'Bash',
      input: 'ls',
      rule: 'Bash(ls)',
      output: 'a\nb',
      status: 'ok',
    })
  })

  it('folds a reused tool id only within the current ride', () => {
    const prior: ToolItem = {
      id: 'item_1',
      at: AT,
      rideId: 'r0',
      kind: 'tool',
      name: 'Bash',
      input: 'old command',
      output: 'old output',
      status: 'ok',
    }
    const t = task({
      items: [
        { id: 'u0', at: AT, kind: 'message', role: 'user', text: 'do it' },
        prior,
      ],
      rides: [
        { id: 'r0', startedAt: AT, endedAt: AT, outcome: 'done' },
        { id: 'r1', startedAt: AT },
      ],
    })

    applyUpdate(
      t,
      update({
        steps: [
          step({ kind: 'tool_use', tool: 'Bash', input: 'new command', toolUseId: 'item_1' }),
          step({ kind: 'tool_result', toolUseId: 'item_1', text: 'new output' }),
        ],
        cursor: 1,
      }),
    )

    expect(prior).toMatchObject({ output: 'old output', status: 'ok' })
    expect(rideItems(t, 'r1').filter((i) => i.kind === 'tool')).toEqual([
      expect.objectContaining({
        id: 'item_1',
        input: 'new command',
        output: 'new output',
        status: 'ok',
      }),
    ])
  })

  it('keeps a result-only reused id as an orphan in the current ride', () => {
    const prior: ToolItem = {
      id: 'item_2',
      at: AT,
      rideId: 'r0',
      kind: 'tool',
      name: 'Read',
      input: 'old input',
      output: 'old output',
      status: 'ok',
    }
    const t = task({
      items: [
        { id: 'u0', at: AT, kind: 'message', role: 'user', text: 'do it' },
        prior,
      ],
      rides: [
        { id: 'r0', startedAt: AT, endedAt: AT, outcome: 'done' },
        { id: 'r1', startedAt: AT },
      ],
    })

    applyUpdate(
      t,
      update({
        steps: [
          step({ kind: 'tool_result', toolUseId: 'item_2', text: 'failed', isError: true }),
        ],
        cursor: 1,
      }),
    )

    expect(prior).toMatchObject({ output: 'old output', status: 'ok' })
    expect(rideItems(t, 'r1').filter((i) => i.kind === 'tool')).toEqual([
      expect.objectContaining({
        id: 'item_2',
        output: 'failed',
        status: 'failed',
      }),
    ])
  })

  it('reconciles blocked tool calls via blockedIds across the whole ride', () => {
    const t = task()
    applyUpdate(
      t,
      update({
        steps: [
          step({ kind: 'tool_use', tool: 'Bash', toolUseId: 'call_1' }),
          step({ kind: 'tool_result', toolUseId: 'call_1' }),
          step({ kind: 'tool_use', tool: 'Read', toolUseId: 'call_2' }),
          step({ kind: 'tool_result', toolUseId: 'call_2' }),
        ],
        cursor: 1,
      }),
    )
    applyUpdate(t, update({ blockedIds: ['call_1'], cursor: 2 }))
    const byId = (id: string) =>
      rideItems(t).find((i) => i.kind === 'tool' && i.id === id) as ToolItem
    expect(byId('call_1').status).toBe('blocked')
    expect(byId('call_2').status).toBe('ok')
  })

  it('updates the ride’s last flow item in place from finalText', () => {
    const t = task()
    applyUpdate(t, update({ steps: [step({ text: 'streamed' })], finalText: 'streamed', cursor: 1 }))
    applyUpdate(t, update({ finalText: 'streamed final', cursor: 2 }))
    const flow = rideItems(t).filter((i) => i.kind === 'message') as MessageItem[]
    expect(flow).toHaveLength(1)
    expect(flow[0].text).toBe('streamed final')
  })

  it('creates a flow item from finalText when the turn streamed no prose', () => {
    const t = task()
    applyUpdate(t, update({ finalText: 'answer', cursor: 1 }))
    const flow = rideItems(t).filter((i) => i.kind === 'message') as MessageItem[]
    expect(flow.map((f) => f.text)).toEqual(['answer'])
  })

  it('records usage on the ride with the driving model overriding the resolved model', () => {
    const t = task()
    const usage: Usage = { input: 1, output: 2, cacheRead: 3, cacheCreation: 4, model: 'sub-model' }
    applyUpdate(t, update({ usage, usageChanged: true, drivingModel: 'main-model', cursor: 3 }))
    expect(t.rides![0].usage).toEqual({ ...usage, model: 'main-model' })
  })

  it('advances the cursor even when nothing else changed', () => {
    const t = task()
    applyUpdate(t, update({ cursor: 99 }))
    expect(rideItems(t)).toHaveLength(0)
    expect(t.runCursor).toBe(99)
    expect(t.updatedAt).toBe(AT)
  })
})

describe('applyDone', () => {
  const done = (over: Partial<Parameters<typeof applyDone>[1]> = {}) => ({
    exitCode: 0,
    interrupted: false,
    stderr: '',
    ...over,
  })

  it('closes the ride done and lands the streamed reply cleanly', () => {
    const t = task()
    applyUpdate(t, update({ steps: [step({ text: 'hello' })], finalText: 'hello', cursor: 1 }))
    const at = '2026-01-01T00:05:00.000Z'
    applyDone(t, done(), { at, askId: 'ask-x-0' })
    expect(t.rides![0]).toMatchObject({ endedAt: at, outcome: 'done' })
    expect(t.status).toBe('riding')
    expect(t.retry).toBeUndefined()
    expect(t.items!.some((i) => i.kind === 'ask')).toBe(false)
    expect('runId' in t).toBe(false)
    expect('runCursor' in t).toBe(false)
  })

  it('wedges, stashes a retry, and raises the usage-limit ask with a reset time', () => {
    const t = task()
    const at = '2026-01-01T00:05:00.000Z'
    applyDone(
      t,
      done({ exitCode: 1, stderr: 'boom' }),
      { at, rateLimitResetsAt: '2026-01-01T01:00:00.000Z', askId: 'ask-x-0' },
    )
    // Error text is recorded as the ride's flow item; the ride closes error.
    const flow = rideItems(t).find((i) => i.kind === 'message') as MessageItem
    expect(flow.text).toBe('error running assistant: exited 1\nboom')
    expect(t.rides![0]).toMatchObject({ outcome: 'error', endedAt: at })
    expect(t.status).toBe('wedged')
    expect(t.retry).toEqual({
      committed: false,
      prompts: ['do it'],
      resetsAt: '2026-01-01T01:00:00.000Z',
    })
    expect(t.items!.some((i) => i.kind === 'event' && i.eventKind === 'wedged')).toBe(true)
    const ask = t.items!.find((i) => i.kind === 'ask')!
    expect(ask).toMatchObject({ id: 'ask-x-0', origin: 'retry', blocking: 'task' })
    expect(ask.kind === 'ask' && ask.form.options.map((o) => o.id)).toEqual([
      'retry-now',
      'retry-at-reset',
    ])
  })

  it('marks committed true when a reply had begun (a tool ran)', () => {
    const t = task()
    applyUpdate(t, update({ steps: [step({ kind: 'tool_use', tool: 'Bash', toolUseId: 'c1' })], cursor: 1 }))
    applyDone(t, done({ exitCode: 1 }), { at: AT, askId: 'ask-x-0' })
    expect(t.status).toBe('wedged')
    expect(t.retry?.committed).toBe(true)
  })

  it('keeps an interrupted run unwedged, recording the stop, and closes it interrupted', () => {
    const t = task()
    applyDone(t, done({ exitCode: 137, interrupted: true }), { at: AT, askId: 'ask-x-0' })
    const flow = rideItems(t).find((i) => i.kind === 'message') as MessageItem
    expect(flow.text).toBe('_(interrupted)_')
    expect(t.status).toBe('riding')
    expect(t.retry).toBeUndefined()
    expect(t.rides![0]).toMatchObject({ outcome: 'interrupted' })
    expect(t.items!.some((i) => i.kind === 'ask')).toBe(false)
  })

  it('raises no ask when the agent had already wedged itself', () => {
    const t = task({ status: 'wedged' })
    applyDone(t, done({ exitCode: 1 }), { at: AT, askId: 'ask-x-0' })
    expect(t.retry).toBeUndefined()
    expect(t.items!.some((i) => i.kind === 'ask')).toBe(false)
  })

  it('names an idle kill in the retry ask and stashes the cause on the ride', () => {
    const t = task()
    // The turn had streamed (a flow message) — the old behavior dropped every
    // diagnostic in exactly this case.
    applyUpdate(t, update({ steps: [step({ text: 'surveying…' })], cursor: 1 }))
    applyDone(
      t,
      done({ exitCode: 1, cause: 'idle-timeout', idleMs: 10 * 60_000 }),
      { at: AT, askId: 'ask-x-0' },
    )
    const ask = t.items!.find((i) => i.kind === 'ask')!
    expect(ask.kind === 'ask' && ask.prompt).toBe(
      'The assistant went silent for 10 minutes and was stopped.',
    )
    expect(t.rides![0].error).toEqual({
      exitCode: 1,
      cause: 'idle-timeout',
      idleMs: 10 * 60_000,
    })
  })

  it('names a host crash and a daemon shutdown in the retry ask', () => {
    for (const [cause, prompt] of [
      ['host-crash', 'The assistant process died without reporting a result.'],
      ['daemon-shutdown', 'The daemon shut down and stopped the run.'],
    ] as const) {
      const t = task()
      applyDone(t, done({ exitCode: 1, cause }), { at: AT, askId: 'ask-x-0' })
      const ask = t.items!.find((i) => i.kind === 'ask')!
      expect(ask.kind === 'ask' && ask.prompt).toBe(prompt)
      expect(t.rides![0].error).toEqual({ exitCode: 1, cause })
    }
  })

  it('surfaces the first stderr line of a natural failure and keeps the tail on the ride', () => {
    const t = task()
    // A tool ran, so the run had streamed output — the stderr must survive anyway.
    applyUpdate(t, update({ steps: [step({ kind: 'tool_use', tool: 'Bash', toolUseId: 'c1' })], cursor: 1 }))
    applyDone(
      t,
      done({ exitCode: 1, stderr: '\nError: session is locked\n  at resume (cli.js:10)\n' }),
      { at: AT, askId: 'ask-x-0' },
    )
    const ask = t.items!.find((i) => i.kind === 'ask')!
    expect(ask.kind === 'ask' && ask.prompt).toBe(
      'The assistant run failed: Error: session is locked',
    )
    expect(t.rides![0].error).toEqual({
      exitCode: 1,
      stderr: 'Error: session is locked\n  at resume (cli.js:10)',
    })
  })

  it('keeps the usage-limit wording when a reset time is present', () => {
    const t = task()
    applyDone(
      t,
      done({ exitCode: 1, cause: 'host-crash' }),
      { at: AT, rateLimitResetsAt: '2026-01-01T01:00:00.000Z', askId: 'ask-x-0' },
    )
    const ask = t.items!.find((i) => i.kind === 'ask')!
    expect(ask.kind === 'ask' && ask.prompt).toBe('Usage limit reached.')
  })

  it('records no error detail on a clean or interrupted ride', () => {
    const t = task()
    applyDone(t, done(), { at: AT, askId: 'ask-x-0' })
    expect(t.rides![0].error).toBeUndefined()

    const t2 = task()
    applyDone(t2, done({ exitCode: 137, interrupted: true }), { at: AT, askId: 'ask-x-0' })
    expect(t2.rides![0].error).toBeUndefined()
  })
})

// A tool's result routinely arrives in a *later* batch than its use (the tool was
// still running when the previous batch was flushed). The result must fold onto the
// item the earlier batch created rather than minting a second one.
describe('continuation across batches', () => {
  it('folds a later batch’s result onto an already-running tool item and finishes', () => {
    const t = task({
      runId: 'live',
      runCursor: 3,
      items: [
        { id: 'u0', at: AT, kind: 'message', role: 'user', text: 'go' },
        { id: 'f0', at: AT, rideId: 'live', kind: 'message', role: 'flow', text: 'working' },
        {
          id: 'call_1',
          at: AT,
          rideId: 'live',
          kind: 'tool',
          name: 'Bash',
          input: 'ls',
          status: 'running',
        },
      ],
      rides: [{ id: 'live', startedAt: AT }],
    })
    // Sanity: an open ride keyed by runId, with a running tool item.
    expect(t.rides!.find((r: Ride) => r.id === 'live' && !r.endedAt)).toBeTruthy()
    const runningTool = (t.items as Item[]).find(
      (i) => i.kind === 'tool' && i.id === 'call_1',
    ) as ToolItem
    expect(runningTool.status).toBe('running')

    // The daemon streams the tool_result for that same call in the next batch.
    applyUpdate(
      t,
      update({
        steps: [{ kind: 'tool_result', toolUseId: 'call_1', text: 'done', createdAt: AT }],
        finalText: 'all set',
        cursor: 4,
      }),
    )
    // The result folded onto the converter's item — not a new one.
    expect((t.items as ToolItem[]).filter((i) => i.kind === 'tool')).toHaveLength(1)
    expect((t.items!.find((i) => i.kind === 'tool') as ToolItem).output).toBe('done')

    applyDone(t, { exitCode: 0, interrupted: false, stderr: '' }, { at: '2026-01-01T00:05:00.000Z', askId: 'ask-x-0' })
    expect(t.rides!.find((r: Ride) => r.id === 'live')!.outcome).toBe('done')
    expect('runId' in t).toBe(false)
  })
})
