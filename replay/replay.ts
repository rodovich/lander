// Running a candidate hook body against a case, and scoring what it did.
//
// The ctx here implements the same surface the host builds, and says so to the
// typechecker: a verb added to the real one and not to this one is a build
// failure rather than a silently wrong score. What the type link does NOT catch
// is the record projection — `target.read()` is typed `Promise<unknown>` — so
// the truncation tests are what cover that.
//
// Two deliberate divergences from production, both from the same fact: Codex's
// clamp is `--sandbox read-only`, which permits reads AND shell.
//
//   - `ctx.spawn` always refuses. There is no faithful tree for a replayed case
//     (uncommitted state is unrecoverable, and that is exactly what the
//     commit-push class is about), so a body that depends on one must fail
//     loudly rather than score against today's checkout.
//   - the judge runs in an empty directory with the task credential stripped,
//     so it cannot read a tree two months newer than its case, and cannot reach
//     lander as the task that is running the harness.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runAssist, type AssistResult, isAssistProvider } from '../daemon/assist'
import type { buildCtx } from '../daemon/hook-host'
import type { ReplayCase } from './corpus'

// Derived here rather than exported from the host, so `replay/` touches nothing
// under `daemon/` — an `import type` is erased, and a non-test `.ts` edit there
// would drain the running daemon on every iteration of this file.
type HookCtx = ReturnType<typeof buildCtx>

export type CaseResult = {
  case: ReplayCase
  // Every verb the body reached for, performed by none of them.
  actions: { kind: string; text?: string }[]
  reports: string[]
  spawns: string[]
  judge: { asked: boolean }
  outcome: 'ran' | 'error' | 'timeout'
  error?: string
  ms: number
}

// A case FIRED if the body acted or reported. One definition, not a flag: a
// report-only stage acts by reporting, and scoring it on actions alone would
// score every such stage as silent.
export const fired = (r: CaseResult): boolean =>
  r.actions.length > 0 || r.reports.length > 0

export type JudgeMode = 'none' | 'live'

export type ReplayDeps = {
  judge: JudgeMode
  stateDir: string
  // Test seam. Production passes nothing and gets the real one-shot.
  assist?: (input: { provider: string; prompt: string; cwd: string }) => Promise<AssistResult>
  // Answers already paid for, keyed by a hash of the prompt.
  cache?: Map<string, AssistResult>
  onJudge?: (key: string, result: AssistResult) => void
}

// A stable key for an answer already paid for. Not crypto — a collision costs a
// wrong cached verdict, and the inputs are prompts from one corpus.
export function promptKey(provider: string, prompt: string): string {
  let h = 5381
  for (let i = 0; i < prompt.length; i++) h = ((h * 33) ^ prompt.charCodeAt(i)) >>> 0
  return `${provider}-${prompt.length}-${h.toString(36)}`
}

// The credential of whatever task is running the harness. A judge that can run a
// shell — which Codex's read-only sandbox permits — would otherwise be able to
// act as that task. A deny-list rather than a `LANDER_*` glob: `assistArgv`
// reads LANDER_CODEX_PROFILE and LANDER_CODEX_CONFIG out of the same
// environment, and stripping those gives every Codex case a differently
// configured judge, or an unauthenticated one.
const STRIPPED = ['LANDER_TOKEN', 'LANDER_TASK', 'LANDER_API', 'LANDER_PROJECT']

export function judgeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const k of STRIPPED) delete out[k]
  return out
}

export function buildReplayCtx(
  c: ReplayCase,
  deps: ReplayDeps,
): { ctx: HookCtx; result: Omit<CaseResult, 'case' | 'outcome' | 'ms'> } {
  const actions: { kind: string; text?: string }[] = []
  const reports: string[] = []
  const spawns: string[] = []
  // A box, not a boolean: the result object is built before the body runs, and a
  // primitive would be snapshotted at false — which reads as "the judge never
  // ran" on a run where it ran on every case.
  const judge = { asked: false }

  const ctx = {
    target: {
      id: c.task,
      project: c.project,
      flow: c.flow,
      // There is no faithful cwd for a replayed case — the tree has moved on by
      // weeks. The project root is what a body would have been handed if the
      // task never left it, and a body that goes on to USE it reaches `spawn`,
      // which refuses and says so in the report.
      cwd: process.cwd(),
      worktree: undefined,
      read: async () => c.record,
    },
    trigger: c.trigger,
    hook: {
      name: 'candidate',
      path: 'replay',
      blob: 'replay',
      fireId: `replay-${c.task}-${c.trigger.at}`,
      trigger: c.trigger.kind,
      by: c.trigger.by,
    },
    project: { slug: c.project, root: process.cwd() },
    stateDir: deps.stateDir,
    // Recorded, never run. The report names every refused command, so "this body
    // is not scoreable as written" is a result rather than a silence.
    spawn: async (cmd: string, args: string[] = []) => {
      spawns.push([cmd, ...args].join(' '))
      return {
        code: -1,
        stdout: '',
        stderr: 'the replay harness does not reconstruct repository state',
      }
    },
    nudge: async (text: string) => {
      actions.push({ kind: 'nudge', text: String(text) })
      return { ok: true as const }
    },
    land: async () => {
      actions.push({ kind: 'land' })
      return { ok: true as const }
    },
    launch: async (message: string) => {
      actions.push({ kind: 'launch', text: String(message) })
      return { ok: true as const, id: 'replay-task' }
    },
    assist: async (prompt: string): Promise<AssistResult> => {
      judge.asked = true
      if (deps.judge === 'none')
        return { ok: false, error: 'judging is off in this replay' }
      const provider = isAssistProvider(c.flow) ? c.flow : 'claude'
      const key = promptKey(provider, String(prompt))
      const hit = deps.cache?.get(key)
      if (hit) return hit
      const dir = await mkdtemp(path.join(tmpdir(), 'lander-replay-judge-'))
      try {
        const answer = deps.assist
          ? await deps.assist({ provider, prompt: String(prompt), cwd: dir })
          : await runAssist({
              provider,
              prompt: String(prompt),
              cwd: dir,
              env: judgeEnv(process.env),
            })
        deps.cache?.set(key, answer)
        deps.onJudge?.(key, answer)
        return answer
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },
    report: (text: string) => {
      reports.push(String(text))
    },
  } satisfies HookCtx

  return { ctx, result: { actions, reports, spawns, judge } }
}

// Run one candidate against one case.
//
// In-process, where production spawns a host per fire — weaker on purpose, since
// this is a dev instrument. The budget is the daemon's kill budget and must stay
// above the assist's own 75s, or a slow judge is recorded as a timeout where
// production would have had a verdict. A `process.exit` in a body still ends the
// run, which is why the CLI checkpoints.
export async function runCase(
  modulePath: string,
  c: ReplayCase,
  deps: ReplayDeps,
  timeoutMs = 150_000,
): Promise<CaseResult> {
  const started = Date.now()
  const { ctx, result } = buildReplayCtx(c, deps)
  const done = (outcome: CaseResult['outcome'], error?: string): CaseResult => ({
    case: c,
    ...result,
    outcome,
    ...(error ? { error } : {}),
    ms: Date.now() - started,
  })

  let mod: { default?: (ctx: HookCtx) => unknown; meta?: { api?: number } }
  try {
    mod = (await import(pathToFileURL(modulePath).href)) as typeof mod
  } catch (e) {
    return done('error', e instanceof Error ? e.message : String(e))
  }
  if (typeof mod.default !== 'function')
    return done('error', 'the candidate has no default export')

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      Promise.resolve(mod.default(ctx)).then(() => 'ran' as const),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      }),
    ])
    return done(outcome)
  } catch (e) {
    return done('error', e instanceof Error ? (e.stack ?? e.message) : String(e))
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ── Scoring ────────────────────────────────────────────────────────────────

export type Report = {
  cases: number
  judgeMode: JudgeMode
  // Every labeled positive, individually. NOT a rate: inside a gate the classes
  // run to four or five cases each, and a percentage over four cases is
  // decoration. What a reader needs is which ones were missed and why.
  positives: { task: string; title: string; class: string; fired: boolean; why: string }[]
  // The share of the whole population the body acted on. On a census this IS the
  // deployed positive rate — the figure a cost estimate consumes — and it is
  // label-independent, so it is the one number the label set's limits do not
  // touch.
  firedRate: string
  firedCount: number
  negatives: number
  falsePositives: number
  falsePositiveRate: string
  // A FLOOR, not an estimate. The label set is a lower bound on the positive
  // class, so every landing with a real problem nobody reopened sits among the
  // negatives and scores as a false positive when the judge correctly flags it.
  // An unbiased number comes from adjudicating the flagged cases directly.
  precisionFloor: string
  // What the run could not see, printed with every score.
  caveats: string[]
  errors: { task: string; error: string }[]
  flagged: { task: string; title: string; label: string; why: string }[]
}

const pct = (n: number, d: number): string =>
  d ? `${((100 * n) / d).toFixed(1)}%` : '—'

export function score(results: CaseResult[], judgeMode: JudgeMode): Report {
  const positives = results.filter((r) => r.case.shouldFire)
  const negatives = results.filter((r) => !r.case.shouldFire)
  const firedCount = results.filter(fired).length
  const fp = negatives.filter(fired).length
  const tp = positives.filter(fired).length
  const why = (r: CaseResult): string =>
    r.reports[0] ?? r.actions[0]?.text ?? r.actions[0]?.kind ?? r.error ?? ''

  const spawnCount = results.reduce((n, r) => n + r.spawns.length, 0)
  const judgedCount = results.filter((r) => r.judge.asked).length
  const caveats = [
    judgeMode === 'none'
      ? 'JUDGING IS OFF. This is a smoke test, not a score: a body that defers to its judge reports nothing, so recall and the false-positive rate are zero by construction.'
      : `the judge ran on ${judgedCount} of ${results.length} cases`,
    'recall is recall against REOPENINGS — a landing whose problem nobody reopened is invisible, so the label set is a lower bound on the positive class',
    'precision is a FLOOR for the same reason; an unbiased figure needs the flagged cases adjudicated directly',
    'the replay always reports nothing queued, and no item carries the queued flag',
    'repository state is not reconstructed: uncommitted state is unrecoverable, which is exactly what the commit-push class is about',
    'a gate that looks for anything AFTER the fire cannot fire here — truncation removes it — so such a gate contributes nothing to the rate below and is untested by this run',
  ]
  if (spawnCount)
    caveats.push(
      `${spawnCount} spawn(s) were REFUSED — a body reaching for the tree is not scoreable as written`,
    )

  return {
    cases: results.length,
    judgeMode,
    positives: positives.map((r) => ({
      task: r.case.task,
      title: r.case.title,
      class: r.case.label,
      fired: fired(r),
      why: why(r),
    })),
    firedRate: pct(firedCount, results.length),
    firedCount,
    negatives: negatives.length,
    falsePositives: fp,
    falsePositiveRate: pct(fp, negatives.length),
    precisionFloor: pct(tp, tp + fp),
    caveats,
    errors: results
      .filter((r) => r.outcome !== 'ran')
      .map((r) => ({ task: r.case.task, error: r.error ?? r.outcome })),
    flagged: results
      .filter(fired)
      .map((r) => ({
        task: r.case.task,
        title: r.case.title,
        label: r.case.label,
        why: why(r),
      })),
  }
}
