// What the harness may and may not claim, and the two divergences from
// production that keep a scoring run from being contaminated by the present.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildReplayCtx,
  fired,
  judgeEnv,
  runCase,
  score,
  type CaseResult,
  type ReplayDeps,
} from './replay'
import type { ReplayCase } from './corpus'

const AT = '2026-01-01T00:00:00.000Z'

const testCase = (over: Partial<ReplayCase> = {}): ReplayCase => ({
  project: 'proj',
  task: 'tsk-1',
  title: 'A task',
  trigger: { kind: 'landed', by: 'agent', at: AT },
  label: 'clean',
  shouldFire: false,
  flow: 'claude',
  record: { id: 'tsk-1', items: [] },
  tools: 3,
  ...over,
})

const deps = (over: Partial<ReplayDeps> = {}): ReplayDeps => ({
  judge: 'none',
  stateDir: '/tmp/replay-state',
  ...over,
})

const dirs: string[] = []
async function candidate(source: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lander-replay-test-'))
  dirs.push(dir)
  const file = path.join(dir, 'candidate.mjs')
  await writeFile(file, source)
  return file
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('the offline ctx', () => {
  it('records the verbs instead of performing them', async () => {
    const { ctx, result } = buildReplayCtx(testCase(), deps())
    await ctx.nudge('keep going')
    await ctx.launch('review this')
    await ctx.land()
    ctx.report('found something')
    expect(result.actions).toEqual([
      { kind: 'nudge', text: 'keep going' },
      { kind: 'launch', text: 'review this' },
      { kind: 'land' },
    ])
    expect(result.reports).toEqual(['found something'])
  })

  // A body that depends on the tree has to fail loudly. Scoring it against
  // today's checkout would report a confident number about a repository the case
  // never saw — and uncommitted state, which is what the commit-push class is
  // about, is not recoverable at all.
  it('refuses every spawn, and records what was reached for', async () => {
    const { ctx, result } = buildReplayCtx(testCase(), deps())
    const r = await ctx.spawn('git', ['status', '--porcelain'])
    expect(r.code).toBe(-1)
    expect(r.stderr).toContain('does not reconstruct')
    expect(result.spawns).toEqual(['git status --porcelain'])
  })

  it('answers the judgment-unavailable path when judging is off', async () => {
    const { ctx } = buildReplayCtx(testCase(), deps())
    expect(await ctx.assist('is this done?')).toMatchObject({ ok: false })
  })

  // The flag has to survive being read after the body ran. As a plain boolean it
  // was snapshotted into the result at build time and always read false — which
  // reports "the judge ran on 0 cases" for a run where it ran on every one, and
  // is indistinguishable from a run that genuinely never judged.
  it('records that the judge was asked, after the fact', async () => {
    const { ctx, result } = buildReplayCtx(testCase(), deps())
    expect(result.judge.asked).toBe(false)
    await ctx.assist('is this done?')
    expect(result.judge.asked).toBe(true)
  })

  it('judges with the case’s own provider, in a directory of its own', async () => {
    const seen: { provider: string; cwd: string }[] = []
    const { ctx } = buildReplayCtx(
      testCase({ flow: 'codex' }),
      deps({
        judge: 'live',
        assist: async (input) => {
          seen.push({ provider: input.provider, cwd: input.cwd })
          return { ok: true, text: 'VERDICT: complete' }
        },
      }),
    )
    expect(await ctx.assist('is this done?')).toEqual({
      ok: true,
      text: 'VERDICT: complete',
    })
    expect(seen[0].provider).toBe('codex')
    // Not the project root: Codex's clamp permits reads, so a judge run there
    // could answer from a tree two months newer than its case.
    expect(seen[0].cwd).not.toBe(process.cwd())
  })

  it('re-uses an answer already paid for', async () => {
    let calls = 0
    const cache = new Map()
    const d = deps({
      judge: 'live',
      cache,
      assist: async () => {
        calls++
        return { ok: true as const, text: 'VERDICT: complete' }
      },
    })
    await buildReplayCtx(testCase(), d).ctx.assist('same prompt')
    await buildReplayCtx(testCase(), d).ctx.assist('same prompt')
    expect(calls).toBe(1)
    // A different prompt is a different answer, and is paid for.
    await buildReplayCtx(testCase(), d).ctx.assist('other prompt')
    expect(calls).toBe(2)
  })
})

// The harness runs from a task's shell, and Codex's read-only clamp permits a
// shell — so a judge could otherwise reach lander as the task running the
// harness. The Codex CONFIGURATION has to survive, or every Codex case is judged
// by a differently configured (or unauthenticated) provider.
describe('judgeEnv', () => {
  it('strips the task credential and keeps the provider configuration', () => {
    const out = judgeEnv({
      LANDER_TOKEN: 'secret',
      LANDER_TASK: 'tsk-1',
      LANDER_API: 'http://localhost:41414',
      LANDER_PROJECT: 'proj',
      LANDER_CODEX_PROFILE: 'lander',
      LANDER_CODEX_CONFIG: 'model="o4"',
      PATH: '/usr/bin',
    })
    expect(out.LANDER_TOKEN).toBeUndefined()
    expect(out.LANDER_TASK).toBeUndefined()
    expect(out.LANDER_API).toBeUndefined()
    expect(out.LANDER_PROJECT).toBeUndefined()
    expect(out.LANDER_CODEX_PROFILE).toBe('lander')
    expect(out.LANDER_CODEX_CONFIG).toBe('model="o4"')
    expect(out.PATH).toBe('/usr/bin')
  })
})

describe('runCase', () => {
  it('runs the candidate against the case and collects what it did', async () => {
    const file = await candidate(
      `export default async function (ctx) { ctx.report('saw ' + ctx.target.id) }`,
    )
    const r = await runCase(file, testCase(), deps())
    expect(r.outcome).toBe('ran')
    expect(r.reports).toEqual(['saw tsk-1'])
  })

  // One case's failure is a result, not a failed run: 495 cases must not be lost
  // to one candidate that throws on one record.
  it('records a throw as one error case', async () => {
    const file = await candidate(
      `export default async function () { throw new Error('boom') }`,
    )
    const r = await runCase(file, testCase(), deps())
    expect(r.outcome).toBe('error')
    expect(r.error).toContain('boom')
  })

  it('records a body that never settles as a timeout', async () => {
    const file = await candidate(`export default function () { return new Promise(() => {}) }`)
    const r = await runCase(file, testCase(), deps(), 30)
    expect(r.outcome).toBe('timeout')
  })
})

describe('score', () => {
  const result = (over: Partial<CaseResult> & { case: ReplayCase }): CaseResult => ({
    actions: [],
    reports: [],
    spawns: [],
    judge: { asked: false },
    outcome: 'ran',
    ms: 1,
    ...over,
  })
  const hit = (c: ReplayCase) => result({ case: c, reports: ['incomplete'] })
  const quiet = (c: ReplayCase) => result({ case: c })

  const positive = (task: string) =>
    testCase({ task, label: 'commit-push', shouldFire: true })
  const negative = (task: string) => testCase({ task })

  it('lists every positive individually rather than as a rate', () => {
    const r = score(
      [hit(positive('a')), quiet(positive('b')), quiet(negative('c'))],
      'live',
    )
    // Inside a gate the classes run to four or five cases; a percentage over
    // four cases is decoration, and which one was missed is what a reader needs.
    expect(r.positives).toMatchObject([
      { task: 'a', fired: true },
      { task: 'b', fired: false },
    ])
  })

  it('reports the fired rate over the whole population, which a census makes p', () => {
    const r = score(
      [hit(positive('a')), hit(negative('b')), quiet(negative('c')), quiet(negative('d'))],
      'live',
    )
    expect(r.firedCount).toBe(2)
    expect(r.firedRate).toBe('50.0%')
    expect(r.falsePositives).toBe(1)
    expect(r.falsePositiveRate).toBe('33.3%')
    // A floor, not an estimate: a real problem nobody reopened sits among the
    // negatives and counts against the judge when it correctly flags it.
    expect(r.precisionFloor).toBe('50.0%')
  })

  it('says at the top when judging was off, so a gate score is not read as a judge score', () => {
    const r = score([quiet(positive('a'))], 'none')
    expect(r.caveats[0]).toContain('JUDGING IS OFF')
  })

  it('counts refused spawns as a caveat of its own', () => {
    const r = score(
      [result({ case: negative('a'), spawns: ['git diff', 'git log'] })],
      'live',
    )
    expect(r.caveats.join('\n')).toContain('2 spawn(s) were REFUSED')
  })

  it('treats a report as firing, since a report-only stage acts by reporting', () => {
    expect(fired(hit(negative('a')))).toBe(true)
    expect(fired(quiet(negative('a')))).toBe(false)
    expect(
      fired(result({ case: negative('a'), actions: [{ kind: 'launch' }] })),
    ).toBe(true)
  })
})
