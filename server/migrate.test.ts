import { describe, it, expect } from 'vitest'
import { normalizeStatus, reviveTask, migrateTask, toLegacyShape } from './migrate'
import { buildTimeline } from '../src/timeline'
import type { Step } from './stream'
import type { Message, TaskEvent, Item, Ride } from './tasks'
import type { Ask } from './asks'

describe('normalizeStatus', () => {
  it('rewrites a legacy stored `resting` to the collapsed `riding`', () => {
    expect(normalizeStatus({ status: 'resting' })).toEqual({ status: 'riding' })
  })

  it('leaves the collapsed vocabulary (riding/wedged/landed) untouched', () => {
    for (const status of ['riding', 'wedged', 'landed']) {
      expect(normalizeStatus({ status })).toEqual({ status })
    }
  })

  it('is idempotent', () => {
    const once = normalizeStatus({ status: 'resting' })
    expect(normalizeStatus({ ...once })).toEqual(once)
  })

  it('preserves the rest of the record and mutates in place', () => {
    const rec = { id: 'x', status: 'resting', title: 't', messages: [] }
    const out = normalizeStatus(rec)
    expect(out).toBe(rec)
    expect(out).toEqual({ id: 'x', status: 'riding', title: 't', messages: [] })
  })

})

describe('reviveTask', () => {
  it('applies the status normalization (the sole rule until step 4)', () => {
    expect(reviveTask({ status: 'resting' })).toEqual({ status: 'riding' })
  })
})

// ── migrateTask / toLegacyShape ─────────────────────────────────────────────

const AT = (s: number) => `2026-01-01T00:0${s}:00.000Z`

const step = (over: Partial<Step>): Step => ({
  kind: 'text',
  createdAt: AT(0),
  ...over,
})

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

// A v1 stored task (the slice the converter reads); the rest is carried through.
type V1 = {
  status?: string
  messages: Message[]
  events?: TaskEvent[]
  asks?: Ask[]
  runId?: string
  shape?: number
  [k: string]: unknown
}

const run = (t: V1) => migrateTask(clone(t)) as V1 & { rides: Ride[]; items: Item[] }

// Canonical render tokens for one message: exactly what the UI shows for it (the
// either/or of steps-vs-text, tool_use folded with its result). Used to assert the
// legacy projection renders identically to the original, tolerating the two
// documented, render-invisible losses (tool_result timestamp; stepless legacy
// text ↔ a single reconstructed text step).
function turnTokens(m: Message) {
  const steps = m.steps ?? []
  if (steps.length === 0) return [{ t: 'text', text: m.text }]
  const resultByUse = new Map<string, Step>()
  for (const s of steps)
    if (s.kind === 'tool_result' && s.toolUseId) resultByUse.set(s.toolUseId, s)
  const useIds = new Set(
    steps.filter((s) => s.kind === 'tool_use').map((s) => s.toolUseId),
  )
  const toks: unknown[] = []
  for (const s of steps) {
    if (s.kind === 'text') {
      if (s.text)
        toks.push({ t: 'text', text: s.text, g: s.inferenceId, p: s.parentToolUseId })
    } else if (s.kind === 'tool_use') {
      const r = s.toolUseId ? resultByUse.get(s.toolUseId) : undefined
      toks.push({
        t: 'tool',
        id: s.toolUseId,
        tool: s.tool,
        input: s.input,
        inputFull: s.inputFull,
        rule: s.rule,
        edits: s.edits,
        g: s.inferenceId,
        p: s.parentToolUseId,
        status: r?.blocked ? 'blocked' : r?.isError ? 'failed' : r ? 'ok' : 'running',
        output: r?.text,
      })
    } else if (s.toolUseId && useIds.has(s.toolUseId)) {
      // paired result — folds into its chip, no standalone token
    } else {
      toks.push({
        t: 'orphan',
        id: s.toolUseId,
        output: s.text,
        p: s.parentToolUseId,
        status: s.blocked ? 'blocked' : s.isError ? 'failed' : 'ok',
      })
    }
  }
  return toks
}

const renderProjection = (msgs: Message[]) =>
  msgs.map((m) => ({
    role: m.role,
    text: m.text,
    pending: m.pending ?? false,
    usage: m.usage,
    artifacts: m.artifacts,
    attachments: m.attachments,
    tokens: turnTokens(m),
  }))

describe('migrateTask', () => {
  it('synthesizes one settled ride per assistant message and folds tool pairs', () => {
    const v1: V1 = {
      status: 'riding',
      messages: [
        { role: 'user', text: 'do it', createdAt: AT(0) },
        {
          role: 'assistant',
          text: 'done',
          createdAt: AT(1),
          usage: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 },
          steps: [
            step({ kind: 'text', text: 'thinking', inferenceId: 'inf1', createdAt: AT(1) }),
            step({
              kind: 'tool_use',
              tool: 'Bash',
              input: 'ls',
              toolUseId: 'call_1',
              inferenceId: 'inf1',
              rule: 'Bash(ls)',
              createdAt: AT(2),
            }),
            step({ kind: 'tool_result', toolUseId: 'call_1', text: 'a\nb', createdAt: AT(2) }),
            step({ kind: 'text', text: 'done', inferenceId: 'inf2', createdAt: AT(3) }),
          ],
        },
      ],
    }
    const out = run(v1)
    expect(out.shape).toBe(2)
    expect('messages' in out).toBe(false)
    expect('events' in out).toBe(false)
    expect(out.rides).toHaveLength(1)
    expect(out.rides[0]).toMatchObject({
      startedAt: AT(1),
      endedAt: AT(3),
      outcome: 'done',
      usage: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 },
    })
    const rideId = out.rides[0].id
    // user item (no ride), then the ride's items in step order — the tool_result
    // is folded onto its tool item (no separate item), finalText mirrored the last
    // text step so no reconciliation item was appended.
    expect(out.items.map((i) => [i.kind, 'role' in i ? i.role : ''])).toEqual([
      ['message', 'user'],
      ['message', 'flow'],
      ['tool', ''],
      ['message', 'flow'],
    ])
    const tool = out.items.find((i) => i.kind === 'tool')!
    expect(tool).toMatchObject({
      id: 'call_1',
      rideId,
      name: 'Bash',
      input: 'ls',
      rule: 'Bash(ls)',
      output: 'a\nb',
      status: 'ok',
      groupId: 'inf1',
    })
    expect(out.items[0].rideId).toBeUndefined() // user message out of ride
  })

  it('turns a pending message on a live run into an OPEN ride keyed by runId', () => {
    const v1: V1 = {
      status: 'riding',
      runId: 'live-run',
      messages: [
        { role: 'user', text: 'go', createdAt: AT(0) },
        {
          role: 'assistant',
          text: 'partial',
          createdAt: AT(1),
          pending: true,
          steps: [step({ kind: 'text', text: 'partial', createdAt: AT(1) })],
        },
      ],
    }
    const out = run(v1)
    expect(out.rides).toHaveLength(1)
    expect(out.rides[0].id).toBe('live-run')
    expect(out.rides[0].endedAt).toBeUndefined()
    expect(out.rides[0].outcome).toBeUndefined()
    // The projection restores pending:true from the open ride.
    expect(toLegacyShape(out).messages.at(-1)).toMatchObject({ pending: true })
  })

  it('appends a reconciliation flow item for a stepless legacy message', () => {
    const v1: V1 = {
      status: 'riding',
      messages: [
        { role: 'user', text: 'hi', createdAt: AT(0) },
        { role: 'assistant', text: 'error running assistant: exited 1', createdAt: AT(1), steps: [] },
      ],
    }
    const out = run(v1)
    const flow = out.items.filter((i) => i.kind === 'message' && i.role === 'flow')
    expect(flow).toHaveLength(1)
    expect(flow[0]).toMatchObject({ text: 'error running assistant: exited 1' })
  })

  it('carries codex multi-text as multiple flow items with no duplicate finalText', () => {
    const v1: V1 = {
      status: 'riding',
      messages: [
        { role: 'user', text: 'hi', createdAt: AT(0) },
        {
          role: 'assistant',
          text: 'para two',
          createdAt: AT(1),
          steps: [
            step({ kind: 'text', text: 'para one', createdAt: AT(1) }),
            step({ kind: 'text', text: 'para two', createdAt: AT(2) }),
          ],
        },
      ],
    }
    const out = run(v1)
    const flow = out.items.filter((i) => i.kind === 'message' && i.role === 'flow')
    expect(flow.map((f) => (f.kind === 'message' ? f.text : ''))).toEqual([
      'para one',
      'para two',
    ])
  })

  it('nests subagent steps under the spawning tool via parentId, and blocks/orphans', () => {
    const v1: V1 = {
      status: 'riding',
      messages: [
        { role: 'user', text: 'go', createdAt: AT(0) },
        {
          role: 'assistant',
          text: 'ok',
          createdAt: AT(1),
          steps: [
            step({ kind: 'tool_use', tool: 'Agent', input: 'x', toolUseId: 'spawn', createdAt: AT(1) }),
            step({ kind: 'text', text: 'sub prose', toolUseId: undefined, parentToolUseId: 'spawn', createdAt: AT(2) }),
            step({ kind: 'tool_use', tool: 'Read', input: 'f', toolUseId: 'sub_tool', parentToolUseId: 'spawn', createdAt: AT(2) }),
            step({ kind: 'tool_result', toolUseId: 'sub_tool', text: 'contents', parentToolUseId: 'spawn', createdAt: AT(2) }),
            step({ kind: 'tool_use', tool: 'Bash', input: 'rm', toolUseId: 'blocked_call', createdAt: AT(3) }),
            step({ kind: 'tool_result', toolUseId: 'blocked_call', text: 'denied', blocked: true, isError: true, createdAt: AT(3) }),
            step({ kind: 'tool_result', toolUseId: 'orphan_call', text: 'stray', isError: true, createdAt: AT(3) }),
            step({ kind: 'text', text: 'ok', createdAt: AT(4) }),
          ],
        },
      ],
    }
    const out = run(v1)
    const subProse = out.items.find(
      (i) => i.kind === 'message' && i.role === 'flow' && i.text === 'sub prose',
    )!
    expect(subProse.parentId).toBe('spawn')
    const subTool = out.items.find((i) => i.kind === 'tool' && i.id === 'sub_tool')!
    expect(subTool.parentId).toBe('spawn')
    const blocked = out.items.find((i) => i.kind === 'tool' && i.id === 'blocked_call')!
    expect(blocked).toMatchObject({ status: 'blocked', output: 'denied' })
    const orphan = out.items.find((i) => i.kind === 'tool' && i.id === 'orphan_call')!
    expect(orphan).toMatchObject({ status: 'failed', output: 'stray' })
  })

  it('carries only OPEN asks, lossily dropping answered/withdrawn', () => {
    const mkAsk = (id: string, state: Ask['state']): Ask => ({
      id,
      createdAt: AT(1),
      form: { type: 'choice', options: [{ id: 'a', label: 'A' }] },
      blocking: 'task',
      state,
    })
    const v1: V1 = {
      status: 'wedged',
      messages: [{ role: 'user', text: 'hi', createdAt: AT(0) }],
      asks: [mkAsk('ask-open', 'open'), mkAsk('ask-ans', 'answered'), mkAsk('ask-wd', 'withdrawn')],
    }
    const out = run(v1)
    const askItems = out.items.filter((i) => i.kind === 'ask')
    expect(askItems.map((a) => a.id)).toEqual(['ask-open'])
    expect(toLegacyShape(out).asks.map((a) => a.id)).toEqual(['ask-open'])
  })

  it('carries user attachments and keeps queued follow-ups in append order (no sink)', () => {
    const att = [{ id: 'a1', name: 'f.png', mime: 'image/png', size: 9 }]
    const v1: V1 = {
      status: 'riding',
      queued: ['later'],
      messages: [
        { role: 'user', text: 'first', createdAt: AT(0), attachments: att },
        { role: 'assistant', text: 'reply', createdAt: AT(1), steps: [step({ kind: 'text', text: 'reply', createdAt: AT(1) })] },
        { role: 'user', text: 'later', createdAt: AT(2) },
      ],
    }
    const out = run(v1)
    const users = out.items.filter((i) => i.kind === 'message' && i.role === 'user')
    // Append order preserved (the queued 'later' is NOT sunk in storage).
    expect(users.map((u) => (u.kind === 'message' ? u.text : ''))).toEqual(['first', 'later'])
    expect((users[0] as { attachments?: unknown }).attachments).toEqual(att)
  })

  it('is idempotent: a shape-2 record passes straight through (same reference)', () => {
    const v1: V1 = {
      status: 'riding',
      messages: [
        { role: 'user', text: 'hi', createdAt: AT(0) },
        { role: 'assistant', text: 'yo', createdAt: AT(1), steps: [step({ kind: 'text', text: 'yo', createdAt: AT(1) })] },
      ],
    }
    const once = migrateTask(clone(v1))
    const twice = migrateTask(once)
    expect(twice).toBe(once)
    expect(twice).toEqual(once)
  })

  it('normalizes a legacy `resting` status while converting shape', () => {
    const out = run({ status: 'resting', messages: [] })
    expect(out.status).toBe('riding')
    expect(out.shape).toBe(2)
  })
})

// A rich settled v1 task exercising interleaved events, tools, subagents, blocks,
// codex-style multi-text, a stepless error turn, and attachments — the anchor for
// the golden-order and round-trip properties.
const richV1 = (): V1 => ({
  status: 'riding',
  messages: [
    { role: 'user', text: 'start', createdAt: AT(0), attachments: [{ id: 'a', name: 'x', mime: 'text/plain', size: 1 }] },
    {
      role: 'assistant',
      text: 'first answer',
      createdAt: AT(1),
      usage: { input: 5, output: 6, cacheRead: 1, cacheCreation: 2 },
      steps: [
        step({ kind: 'text', text: 'let me look', inferenceId: 'i1', createdAt: AT(1) }),
        step({ kind: 'tool_use', tool: 'Bash', input: 'ls', toolUseId: 'c1', inferenceId: 'i1', rule: 'Bash(ls)', createdAt: AT(1) }),
        step({ kind: 'tool_result', toolUseId: 'c1', text: 'ok', createdAt: AT(1) }),
        step({ kind: 'text', text: 'first answer', inferenceId: 'i2', createdAt: AT(2) }),
      ],
    },
    { role: 'user', text: 'again', createdAt: AT(3) },
    {
      role: 'assistant',
      text: 'second answer',
      createdAt: AT(4),
      steps: [
        step({ kind: 'tool_use', tool: 'Agent', input: 'sub', toolUseId: 'spawn', createdAt: AT(4) }),
        step({ kind: 'text', text: 'sub says hi', parentToolUseId: 'spawn', createdAt: AT(4) }),
        step({ kind: 'tool_use', tool: 'Bash', input: 'rm', toolUseId: 'c2', createdAt: AT(4) }),
        step({ kind: 'tool_result', toolUseId: 'c2', text: 'no', blocked: true, isError: true, createdAt: AT(4) }),
        step({ kind: 'text', text: 'second answer', createdAt: AT(5) }),
      ],
    },
  ],
  events: [
    { kind: 'launched', title: 't', createdAt: '2026-01-01T00:00:30.000Z' },
    { kind: 'wedged', title: 't', createdAt: '2026-01-01T00:03:30.000Z' },
  ],
})

describe('migrateTask ordering matches buildTimeline', () => {
  it('places events among messages exactly as the renderer interleaves them', () => {
    const v1 = richV1()
    const out = run(v1)
    // buildTimeline over the v1 arrays (settled — last message is an assistant, so
    // `now` is irrelevant to ordering).
    const timeline = buildTimeline(v1, AT(9)).items.map((it) =>
      it.kind === 'event'
        ? `event:${it.event.createdAt}`
        : (it.message as Message).role === 'user'
          ? 'user'
          : 'asst',
    )
    // Collapse the finer item log to the same granularity: a ride's contiguous
    // items → one 'asst', user items → 'user', events by createdAt, asks dropped.
    const collapsed: string[] = []
    let lastRide: string | undefined
    for (const it of out.items) {
      if (it.kind === 'ask') continue
      if (it.kind === 'event') {
        collapsed.push(`event:${it.at}`)
        lastRide = undefined
      } else if (it.kind === 'message' && it.role === 'user') {
        collapsed.push('user')
        lastRide = undefined
      } else if (it.rideId) {
        if (it.rideId !== lastRide) collapsed.push('asst')
        lastRide = it.rideId
      }
    }
    expect(collapsed).toEqual(timeline)
  })
})

describe('toLegacyShape round-trips a converted v1', () => {
  it('reproduces v1 public messages (render-equivalent) and events (exact)', () => {
    const v1 = richV1()
    const out = run(v1)
    const legacy = toLegacyShape(out)
    // Messages render identically (modulo the folded tool_result timestamp and the
    // stepless/one-text-step equivalence, both captured by turnTokens).
    expect(renderProjection(legacy.messages)).toEqual(renderProjection(v1.messages))
    // Events are reproduced byte-for-byte, in order.
    expect(legacy.events).toEqual(v1.events)
  })

  it('round-trips a stepless error turn to render-equivalent text', () => {
    const v1: V1 = {
      status: 'riding',
      messages: [
        { role: 'user', text: 'hi', createdAt: AT(0) },
        { role: 'assistant', text: '_(interrupted)_', createdAt: AT(1), steps: [] },
      ],
    }
    const legacy = toLegacyShape(run(v1))
    expect(renderProjection(legacy.messages)).toEqual(renderProjection(v1.messages))
  })

  it('preserves usage, pending, and artifacts through the round-trip', () => {
    const v1: V1 = {
      status: 'riding',
      runId: 'r',
      messages: [
        { role: 'user', text: 'go', createdAt: AT(0) },
        {
          role: 'assistant',
          text: 'building',
          createdAt: AT(1),
          pending: true,
          usage: { input: 3, output: 4, cacheRead: 0, cacheCreation: 0 },
          artifacts: [{ name: 'out', id: 'b1', mime: 'text/plain', size: 2, createdAt: AT(1), updatedAt: AT(1) }],
          steps: [step({ kind: 'text', text: 'building', createdAt: AT(1) })],
        },
      ],
    }
    const msg = toLegacyShape(run(v1)).messages.at(-1)!
    expect(msg.pending).toBe(true)
    expect(msg.usage).toEqual({ input: 3, output: 4, cacheRead: 0, cacheCreation: 0 })
    expect(msg.artifacts).toEqual(v1.messages[1].artifacts)
  })
})
