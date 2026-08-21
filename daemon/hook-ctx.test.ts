// The hook context's bounded action verbs, in isolation from the host process.
//
// What is under test here is the dedupe key's ordinal, which is the whole of the
// platform's retry guarantee for a hook's actions. Two properties, and each was
// got wrong once before it was got right:
//
//   - it is minted PER INVOCATION, so a retry (a fresh host process) presents the
//     same keys the original did, which is what lets the server recognise a
//     repeat. Derived from the target's stored actions instead, it would never
//     collide — the original's entries push the count past them.
//   - it advances ONLY on acceptance, so an attempt the server never recorded
//     leaves the next action at the same ordinal. Advanced at composition time,
//     a first call that fails offsets the retry by one and the action lands
//     twice.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCtx } from './hook-host'
import type { HookHostInput } from './hook-run'

const input = (): HookHostInput => ({
  run: {
    type: 'hook-run',
    requestId: 'req-1',
    project: 'proj',
    fireId: 'fire-1',
    target: { id: 'tsk-1' },
    trigger: { kind: 'ride-ended', by: 'agent', at: '2026-01-01T00:00:00.000Z' },
    hook: {
      path: '.lander/hooks/ride-ended/any/supervise.js',
      runs: 'b10b',
      name: 'supervise',
      trigger: 'ride-ended',
      by: 'any',
    },
    callback: { api: 'http://127.0.0.1:1', project: 'proj', token: 'tok' },
    timeoutMs: 1000,
    killMs: 2000,
  },
  projectRoot: '/tmp/proj',
  targetCwd: '/tmp/proj',
  stateDir: '/tmp/state',
})

// The keys each call presented, in order, plus a scripted set of answers.
function stubFetch(answers: { status: number; body: unknown }[]): string[] {
  const keys: string[] = []
  let n = 0
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    keys.push(JSON.parse(init.body).key)
    const a = answers[Math.min(n++, answers.length - 1)]
    return {
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      json: async () => a.body,
    } as unknown as Response
  })
  return keys
}

const accepted = { status: 200, body: { ok: true } }
const deduped = { status: 200, body: { ok: true, deduped: true } }

afterEach(() => vi.unstubAllGlobals())

describe('ctx.nudge', () => {
  it('mints ordinals per invocation, so a retry presents the original’s keys', async () => {
    const first = stubFetch([accepted])
    const a = buildCtx(input(), [])
    await a.nudge('one')
    await a.nudge('two')
    expect(first).toEqual(['nudge#0', 'nudge#1'])

    // A retry is a fresh host, so a fresh ctx: the counter restarts and the
    // server meets the keys it already holds.
    vi.unstubAllGlobals()
    const retry = stubFetch([deduped])
    const b = buildCtx(input(), [])
    await b.nudge('one')
    await b.nudge('two')
    expect(retry).toEqual(['nudge#0', 'nudge#1'])
  })

  // The round-2 finding. `credential-unknown` is routine — credentials are
  // process-local and the server restarts on every `server/**` edit — so a first
  // call failing that way must not shift everything after it.
  it('does not advance the ordinal on an attempt the server never recorded', async () => {
    const keys = stubFetch([
      { status: 401, body: { ok: false, reason: 'credential-unknown' } },
      accepted,
    ])
    const ctx = buildCtx(input(), [])
    const failed = await ctx.nudge('one')
    expect(failed).toMatchObject({ ok: false, reason: 'credential-unknown' })
    await ctx.nudge('two')
    // Both at ordinal 0: the first left no entry, so the second belongs there.
    expect(keys).toEqual(['nudge#0', 'nudge#0'])
  })

  it('advances past a deduped action, which is an action the original took', async () => {
    const keys = stubFetch([deduped, accepted])
    const ctx = buildCtx(input(), [])
    await ctx.nudge('one')
    await ctx.nudge('two')
    expect(keys).toEqual(['nudge#0', 'nudge#1'])
  })

  it('leaves the ordinal alone for an explicitly keyed action', async () => {
    const keys = stubFetch([accepted])
    const ctx = buildCtx(input(), [])
    await ctx.nudge('one', { key: 'verdict' })
    await ctx.nudge('two')
    expect(keys).toEqual(['verdict', 'nudge#0'])
  })

  it('names each refusal rather than collapsing them', async () => {
    for (const [status, reason] of [
      [403, 'bound'],
      [403, 'wedged'],
      [401, 'credential-unknown'],
      [500, 'error'],
    ] as const) {
      vi.unstubAllGlobals()
      stubFetch([{ status, body: { ok: false, reason } }])
      const res = await buildCtx(input(), []).nudge('x')
      expect(res).toMatchObject({ ok: false, reason })
    }
  })

  // A body that ignores the return value must not be able to make the bound the
  // quietest thing in the system: the refusal reaches the timeline either way.
  // The server's prose is reported verbatim: the host must not have to know the
  // bound's value, which would mean importing the server's task module into a
  // process spawned fresh for every fire.
  it('reports a bound or wedged refusal, but not a dedupe', async () => {
    const reports: string[] = []
    stubFetch([
      { status: 403, body: { ok: false, reason: 'bound', error: 'already acted 3 times' } },
    ])
    await buildCtx(input(), reports).nudge('x')
    expect(reports.join('\n')).toContain('already acted 3 times')

    vi.unstubAllGlobals()
    const quiet: string[] = []
    stubFetch([deduped])
    await buildCtx(input(), quiet).nudge('x')
    expect(quiet).toEqual([])
  })

  it('answers `error` when the server cannot be reached at all', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED')
    })
    expect(await buildCtx(input(), []).nudge('x')).toMatchObject({
      ok: false,
      reason: 'error',
    })
  })
})

describe('ctx.launch', () => {
  // This verb creates a task, so its answer has to carry the id — and the id has
  // to survive a dedupe, or a retry leaves the body with no handle on what its
  // earlier attempt built.
  it('returns the created task id, and the same id on a deduped retry', async () => {
    stubFetch([{ status: 201, body: { ok: true, id: 'tsk-new' } }])
    expect(await buildCtx(input(), []).launch('review this')).toEqual({
      ok: true,
      id: 'tsk-new',
    })

    vi.unstubAllGlobals()
    stubFetch([{ status: 200, body: { ok: true, deduped: true, id: 'tsk-new' } }])
    expect(await buildCtx(input(), []).launch('review this')).toEqual({
      ok: true,
      deduped: true,
      id: 'tsk-new',
    })
  })

  // Its own ordinal series, so a fire that nudges and launches does not have one
  // verb's count consume the other's keys.
  it('counts its ordinals separately from the other verbs', async () => {
    const keys = stubFetch([{ status: 201, body: { ok: true, id: 'a' } }])
    const ctx = buildCtx(input(), [])
    await ctx.nudge('one')
    await ctx.launch('two')
    await ctx.launch('three')
    expect(keys).toEqual(['nudge#0', 'launch#0', 'launch#1'])
  })

  it('does not advance the ordinal on an attempt the server never recorded', async () => {
    const keys = stubFetch([
      { status: 401, body: { ok: false, reason: 'credential-unknown' } },
      { status: 201, body: { ok: true, id: 'a' } },
    ])
    const ctx = buildCtx(input(), [])
    await ctx.launch('one')
    await ctx.launch('two')
    expect(keys).toEqual(['launch#0', 'launch#0'])
  })

  it('sends the grants and the flow the body asked for, and omits what it did not', async () => {
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>)
      return {
        ok: true,
        status: 201,
        json: async () => ({ ok: true, id: 'a' }),
      } as unknown as Response
    })
    const ctx = buildCtx(input(), [])
    await ctx.launch('plain')
    await ctx.launch('rich', { edits: true, title: 'Review', flow: 'codex' })
    expect(bodies[0]).toEqual({ message: 'plain', key: 'launch#0' })
    expect(bodies[1]).toEqual({
      message: 'rich',
      key: 'launch#1',
      allowEdits: true,
      title: 'Review',
      flow: 'codex',
    })
  })

  it('reports a refusal it can name, so the bound stays visible', async () => {
    const reports: string[] = []
    stubFetch([
      {
        status: 403,
        body: { ok: false, reason: 'bound', error: 'already acted 3 times' },
      },
    ])
    const res = await buildCtx(input(), reports).launch('x')
    expect(res).toMatchObject({ ok: false, reason: 'bound' })
    expect(reports.join('\n')).toContain('already acted 3 times')
  })
})
