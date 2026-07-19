// The open-PR flow: the validating example for the flow inversion.
//
// It exists to exercise the whole driver surface against something that isn't a
// chat agent — emit (tool items for real work), state (phase, branch, PR
// number), artifacts (the diff packet and a self-review), wedge (approval),
// rest/wakeup re-entry (CI watching with no in-process sleep), launch (a repair
// sibling on failure), and view (reading back its own answered ask).
//
// Four phases, driven by ctx.state.phase; EVERY ride is a re-entry:
//
//   collect            → read the working tree, write artifacts, ask for approval
//   awaiting-approval  → read the answer, continue or stop
//   push               → push the branch and open the PR, each behind a probe
//   watch              → poll checks, resting between attempts
//
// Two rules run through all of it:
//
//   1. Every phase write goes through setPhase(), which FLUSHES. State batches
//      lazily and the only other mid-turn flush is a ctx.spawn drain, so a
//      phase write before a non-spawn transition would otherwise be lost to an
//      interrupt — and the flow would re-enter a phase it had already left,
//      silently redoing outward-visible work.
//
//   2. Every outward step is idempotent, guarded by a PROBE of the world rather
//      than by state alone. Orchestration calls are not transactional with the
//      ride (an in-flight fetch dies with the host on interrupt), so state can
//      always be one step behind reality.
//
// dryRun defaults to TRUE and is fail-safe: anything but the literal boolean
// `false` means dry-run. flowConfig values arrive from `--key` argv coerced
// through JSON.parse, so a mis-coerced "false" string must not enable pushing.

import type { AgentLaunchDir, AgentLaunchDirInput } from '../agent'
import type { Ctx, FlowMeta, TurnResult } from './ctx'

export const meta: FlowMeta = {
  api: 1,
  name: 'open-pr',
  description: 'Review the working tree, ask for approval, open a PR, watch CI',
  driver: true,
  capabilities: {
    // No worktree re-entry: it runs in the recorded cwd.
    worktrees: false,
    vision: 'read',
    // It runs git and gh, not a permission-gated agent, so there is nothing to
    // grant.
    grants: { task: false, project: false },
    usageSnapshot: false,
    rateLimitRetry: false,
    reportsCost: false,
  },
}

// Required by FLOW_MODULES. Trivial: the recorded cwd if it still exists, and
// no re-entry argv.
export function resolveLaunchDir({
  root,
  recordedCwd,
  isDir,
}: AgentLaunchDirInput): AgentLaunchDir {
  const cwd = recordedCwd && isDir(recordedCwd) ? recordedCwd : root
  return { cwd, reentryArgs: [] }
}

// ── Tunables ────────────────────────────────────────────────────────────────

// Rest between CI polls, and the cap on how many times we do it. The interval
// is deliberately realistic rather than short: every wakeup of an
// already-ridden task pushes a synthetic "Resumed at …" USER item, so a tight
// poll would write a wall of fake user turns. 12 attempts ≈ 1 hour ≈ 12 such
// items, which is the noise budget that made it acceptable to defer "quiet
// rest" to step 6 (where watch-ci actually motivates it).
const WATCH_INTERVAL_MIN = 5
const MAX_WATCH_ATTEMPTS = 12

type Phase = 'collect' | 'awaiting-approval' | 'push' | 'watch'

// The command as a user would type it — the tool item's displayed input, and in
// dry-run the whole point of the emission: the exact argv that WOULD have run.
function argvLine(command: string, args: string[]): string {
  return [command, ...args.map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a))].join(
    ' ',
  )
}

// The flow's own ask options. Matching on these ids is what makes an
// unrecognized answer detectable as "superseded" rather than falling through.
const APPROVE = 'open-pr'
const CANCEL = 'cancel'
const KEEP_WATCHING = 'keep-watching'
const STOP_WATCHING = 'stop-watching'

// ── Reading the flow's own asks ─────────────────────────────────────────────

type ServedAsk = {
  id: string
  kind: string
  blocking?: string
  state?: string
  origin?: string
  answer?: { optionId?: string }
}

// The flow's most recent ask at the given blocking level.
//
// `origin === undefined` is the load-bearing filter. Platform retry asks are
// ALSO blocking:'task' and are appended AFTER the flow's own, so "the last
// task-blocking ask" would select one: a `git push` failure exits non-zero
// while riding, applyDone raises a retry ask, the user clicks "Try again",
// applyRetryRecovery re-drives, and the flow would read an answer whose
// optionId is `retry-now` — matching none of its branches, and silently
// discarding an approval the user already gave. It would also violate the
// ownership rule that a flow only ever sees answers to its own questions.
export function findOwnAsk(
  view: unknown,
  blocking: 'task' | 'none',
): ServedAsk | undefined {
  const items = (view as { items?: ServedAsk[] } | undefined)?.items ?? []
  let found: ServedAsk | undefined
  for (const item of items)
    if (
      item.kind === 'ask' &&
      item.origin === undefined &&
      item.blocking === blocking
    )
      found = item
  return found
}

// ── The turn ────────────────────────────────────────────────────────────────

export function makeFlow(): {
  meta: FlowMeta
  onTurn(ctx: Ctx): Promise<TurnResult>
} {
  return { meta, onTurn }
}

async function onTurn(ctx: Ctx): Promise<TurnResult> {
  // Fail-safe: only the literal boolean false leaves dry-run.
  const dryRun = (ctx.task.flowConfig?.dryRun as unknown) !== false
  // Which scripted CI outcome dry-run walks. Both terminal branches matter, so
  // a dry run has to be able to reach either.
  const rawOutcome = ctx.task.flowConfig?.dryRunOutcome
  const dryRunOutcome: 'passed' | 'failed' | 'pending' =
    rawOutcome === 'passed' || rawOutcome === 'pending' ? rawOutcome : 'failed'

  // Every phase write flushes, so an interrupt can never strand the flow in a
  // phase it has already left.
  const setPhase = (phase: Phase): void => {
    ctx.state.set(['phase'], phase)
    ctx.state.flush()
  }

  // Run a command as a tool item, so the work renders in the timeline exactly
  // as an agent's would. Returns stdout.
  const run = async (
    command: string,
    args: string[],
    opts: { label?: string } = {},
  ): Promise<{ out: string; code: number }> => {
    const h = ctx.emit.tool({
      name: opts.label ?? `${command} ${args[0] ?? ''}`.trim(),
      input: argvLine(command, args),
    })
    const child = ctx.spawn(command, args, { cwd: ctx.task.cwd })
    const lines: string[] = []
    for await (const line of child.lines()) lines.push(line)
    const code = await child.exit
    const out = lines.join('\n')
    h.result({ output: out || '(no output)', isError: code !== 0 })
    return { out, code }
  }

  // A mutating command. In dry-run it emits the exact argv it WOULD run and
  // reports nothing else — every read, artifact, ask, rest and re-entry still
  // happens for real, so the only thing dry-run removes is the outward effect.
  const runMutating = async (
    command: string,
    args: string[],
  ): Promise<{ out: string; code: number }> => {
    if (dryRun) {
      const h = ctx.emit.tool({
        name: `[dry-run] ${command} ${args[0] ?? ''}`.trim(),
        input: argvLine(command, args),
      })
      h.result({
        output: `dry run — would have run:\n${argvLine(command, args)}`,
      })
      return { out: '', code: 0 }
    }
    return run(command, args)
  }

  const phase = (ctx.state.get(['phase']) as Phase | undefined) ?? 'collect'

  // Phases fall through deliberately: an approval continues into `push` in the
  // SAME ride rather than making the user send another message.
  let current: Phase = phase
  for (let guard = 0; guard < 8; guard++) {
    if (current === 'collect') {
      const next = await collect(ctx, { run, setPhase })
      if (next === 'stop') return { exitCode: 0 }
      current = next
      // collect ends by wedging for approval; the ride ends here.
      return { exitCode: 0 }
    }

    if (current === 'awaiting-approval') {
      const decision = await readApproval(ctx)
      if (decision === 'approved') {
        setPhase('push')
        current = 'push'
        continue
      }
      if (decision === 'cancelled') {
        ctx.emit.message('Cancelled — no branch was pushed and no PR opened.')
        return { exitCode: 0 }
      }
      // Superseded: the ask was withdrawn, is still open, was never found, or
      // came back with an optionId this flow never authored. Re-collect in the
      // SAME ride rather than swallowing the user's message and demanding a
      // second one.
      ctx.emit.message(
        'The approval question was superseded, so I re-read the working tree.',
      )
      setPhase('collect')
      current = 'collect'
      continue
    }

    if (current === 'push') {
      await push(ctx, { run, runMutating, setPhase, dryRun })
      // push ends by resting; the ride ends here.
      return { exitCode: 0 }
    }

    if (current === 'watch') {
      await watch(ctx, { run, setPhase, dryRun, dryRunOutcome })
      return { exitCode: 0 }
    }
  }

  ctx.emit.message(`open-pr: phase loop did not settle (last phase: ${current}).`)
  return { exitCode: 1 }
}

// ── collect ─────────────────────────────────────────────────────────────────

type Runner = (
  command: string,
  args: string[],
  opts?: { label?: string },
) => Promise<{ out: string; code: number }>

async function collect(
  ctx: Ctx,
  { run, setPhase }: { run: Runner; setPhase: (p: Phase) => void },
): Promise<'awaiting-approval' | 'stop'> {
  const branch = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim()
  const status = (await run('git', ['status', '--short'])).out
  const diff = (await run('git', ['diff', 'HEAD'])).out
  const log = (await run('git', ['log', '--oneline', '-10'])).out

  if (!status.trim() && !diff.trim()) {
    ctx.emit.message(
      `Nothing to open a PR for: the working tree on \`${branch}\` is clean.`,
    )
    return 'stop'
  }

  ctx.state.set(['branch'], branch)

  // The diff packet and a short self-review, as artifacts rather than state —
  // state records decisions and identities; anything bulky belongs here.
  await ctx.artifacts.put(
    'diff.patch',
    diff || '(no unstaged/uncommitted diff against HEAD)',
  )
  await ctx.artifacts.put(
    'review.md',
    [
      `# Change review for \`${branch}\``,
      '',
      '## Working tree',
      '```',
      status.trim() || '(clean)',
      '```',
      '',
      '## Recent commits',
      '```',
      log.trim() || '(none)',
      '```',
      '',
      `Diff size: ${diff.length} bytes.`,
    ].join('\n'),
  )

  ctx.emit.message(
    [
      `Ready to open a PR from \`${branch}\`.`,
      '',
      'I wrote two artifacts: `diff.patch` and `review.md`.',
      '',
      'Approving will push the branch and open a PR.',
    ].join('\n'),
  )

  // Phase written BEFORE the call that causes the transition, and flushed.
  setPhase('awaiting-approval')
  await ctx.wedge({
    prompt: `Open a pull request from ${branch}?`,
    options: [
      { id: APPROVE, label: 'Open PR' },
      { id: CANCEL, label: 'Cancel' },
    ],
  })
  return 'awaiting-approval'
}

// ── awaiting-approval ───────────────────────────────────────────────────────

async function readApproval(
  ctx: Ctx,
): Promise<'approved' | 'cancelled' | 'superseded'> {
  // Exact, from data the server already serves — not by matching the user's
  // message text against option labels, which is unreliable twice over: a
  // prompted ask delivers `Answer to "<first line>": <value>` rather than the
  // bare label, and any co-queued message makes prompts[0] a joined blob.
  const ask = findOwnAsk(await ctx.view(), 'task')
  if (!ask || ask.state !== 'answered') return 'superseded'
  if (ask.answer?.optionId === APPROVE) return 'approved'
  if (ask.answer?.optionId === CANCEL) return 'cancelled'
  // An optionId this flow never authored — treat as superseded rather than as
  // an unhandled case, which is what makes the branch set total.
  return 'superseded'
}

// ── push ────────────────────────────────────────────────────────────────────

async function push(
  ctx: Ctx,
  {
    run,
    runMutating,
    setPhase,
    dryRun,
  }: {
    run: Runner
    runMutating: Runner
    setPhase: (p: Phase) => void
    dryRun: boolean
  },
): Promise<void> {
  const branch = String(ctx.state.get(['branch']) ?? '').trim() || 'HEAD'

  // Probe before pushing. A re-entry after an interrupt mid-push must not
  // double-push, and state alone can't tell us — the interrupt may have landed
  // after the push but before the state write.
  const remote = await run('git', ['ls-remote', '--heads', 'origin', branch], {
    label: 'git ls-remote (probe)',
  })
  if (remote.out.trim())
    ctx.emit.message(`Branch \`${branch}\` is already on origin; skipping the push.`)
  else await runMutating('git', ['push', '-u', 'origin', branch])

  // Same again for the PR itself.
  const existing = await run('gh', ['pr', 'list', '--head', branch, '--json', 'number'], {
    label: 'gh pr list (probe)',
  })
  let prNumber = firstPrNumber(existing.out)

  if (prNumber === undefined) {
    const created = await runMutating('gh', [
      'pr',
      'create',
      '--head',
      branch,
      '--fill',
    ])
    prNumber = firstPrNumber(created.out) ?? parsePrNumberFromUrl(created.out)
    // Dry-run has no real PR, so synthesize one — otherwise `gh pr checks` has
    // no argument and the watch phase, the part this flow exists to
    // demonstrate, would never be exercised.
    if (prNumber === undefined && dryRun) prNumber = 9999
  } else {
    ctx.emit.message(`PR #${prNumber} already exists for \`${branch}\`.`)
  }

  if (prNumber !== undefined) ctx.state.set(['prNumber'], prNumber)
  ctx.state.set(['attempts'], 0)
  ctx.emit.message(
    dryRun
      ? `Dry run: would now watch checks for PR #${prNumber}.`
      : `Opened PR #${prNumber}. Watching its checks.`,
  )

  setPhase('watch')
  await ctx.rest({ time: WATCH_INTERVAL_MIN })
}

// `gh --json number` output, or undefined when there is none.
export function firstPrNumber(out: string): number | undefined {
  try {
    const parsed = JSON.parse(out) as { number?: number }[]
    if (Array.isArray(parsed) && typeof parsed[0]?.number === 'number')
      return parsed[0].number
  } catch {
    // Not JSON — fall through.
  }
  return undefined
}

// `gh pr create` prints the PR URL on success.
export function parsePrNumberFromUrl(out: string): number | undefined {
  const m = out.match(/\/pull\/(\d+)/)
  return m ? Number(m[1]) : undefined
}

// ── watch ───────────────────────────────────────────────────────────────────

async function watch(
  ctx: Ctx,
  {
    run,
    setPhase,
    dryRun,
    dryRunOutcome,
  }: {
    run: Runner
    setPhase: (p: Phase) => void
    dryRun: boolean
    dryRunOutcome: 'passed' | 'failed' | 'pending'
  },
): Promise<void> {
  const prNumber = ctx.state.get(['prNumber'])
  const attempts = Number(ctx.state.get(['attempts']) ?? 0)

  // Read back the advisory ask, if one is open. Answering an advisory ask
  // drives the task immediately but does NOT clear the scheduledFor the rest
  // armed, so the armed wakeup still fires afterwards — this phase has to be
  // idempotent per wakeup and must not assume the interval elapsed. It is: one
  // probe, no accumulation.
  const advisory = findOwnAsk(await ctx.view(), 'none')
  const consumed = (ctx.state.get(['consumedAsks']) as string[] | undefined) ?? []
  let attemptsReset = false
  if (advisory && advisory.state === 'answered' && !consumed.includes(advisory.id)) {
    // Consume exactly once. Without this the answer is re-read on every wakeup,
    // so "Keep watching" would reset the counter forever — quietly defeating
    // both the attempt bound and the noise budget that bound exists to protect.
    ctx.state.push(['consumedAsks'], advisory.id)
    if (advisory.answer?.optionId === STOP_WATCHING) {
      ctx.emit.message('Stopped watching, as requested. The PR is still open.')
      return
    }
    if (advisory.answer?.optionId === KEEP_WATCHING) {
      ctx.state.set(['attempts'], 0)
      attemptsReset = true
      ctx.emit.message('Continuing to watch, with the attempt count reset.')
    }
  }

  const result = dryRun
    ? scriptedCheck(attempts, dryRunOutcome)
    : classifyChecks(
        await run('gh', ['pr', 'checks', String(prNumber)], {
          label: `gh pr checks ${prNumber}`,
        }),
      )

  if (dryRun)
    ctx.emit
      .tool({
        name: `[dry-run] gh pr checks ${prNumber}`,
        input: argvLine('gh', ['pr', 'checks', String(prNumber)]),
      })
      .result({ output: `dry run — scripted result: ${result}` })

  if (result === 'passed') {
    ctx.emit.message(`Checks passed for PR #${prNumber}. Done.`)
    return
  }

  if (result === 'failed') {
    await ctx.artifacts.put(
      'ci-failure.log',
      `Checks failed for PR #${prNumber} after ${attempts + 1} attempt(s).`,
    )
    // A repair sibling, so the failure becomes work rather than a dead end.
    const sibling = (await ctx.launch(
      [
        `CI checks are failing on PR #${prNumber}.`,
        '',
        'The failing-check summary is attached to the task that launched you as',
        'the `ci-failure.log` artifact. Diagnose the failure and fix it.',
      ].join('\n'),
      { title: `Repair CI for PR #${prNumber}`, edits: true },
    )) as { id?: string }
    if (sibling?.id) ctx.state.set(['repairTask'], sibling.id)
    ctx.emit.message(
      `Checks failed for PR #${prNumber}. I wrote \`ci-failure.log\` and launched ` +
        `${sibling?.id ?? 'a repair task'} to fix it.`,
    )
    await ctx.wedge({
      prompt: `CI failed on PR #${prNumber}. What next?`,
      options: [
        { id: 'ack', label: 'Acknowledged' },
        { id: STOP_WATCHING, label: 'Stop watching' },
      ],
    })
    return
  }

  // Pending.
  const nextAttempt = (attemptsReset ? 0 : attempts) + 1
  if (nextAttempt >= MAX_WATCH_ATTEMPTS) {
    ctx.emit.message(
      `Checks for PR #${prNumber} are still pending after ${nextAttempt} attempts ` +
        `(~${(nextAttempt * WATCH_INTERVAL_MIN) / 60} hour). I've stopped watching.`,
    )
    return
  }
  ctx.state.set(['attempts'], nextAttempt)

  // On the FIRST pending result, offer a way out — advisory, so the task keeps
  // resting rather than demanding an answer.
  if (nextAttempt === 1 && !advisory) {
    await ctx.ask({
      prompt: `Checks for PR #${prNumber} are still running. Keep watching?`,
      options: [
        { id: KEEP_WATCHING, label: 'Keep watching' },
        { id: STOP_WATCHING, label: 'Stop watching' },
      ],
    })
  }

  ctx.emit.message(
    `Checks for PR #${prNumber} are still pending (attempt ${nextAttempt}/${MAX_WATCH_ATTEMPTS}).`,
  )
  setPhase('watch')
  await ctx.rest({ time: WATCH_INTERVAL_MIN })
}

// `gh pr checks` exits non-zero when checks fail and prints one row per check.
export function classifyChecks({
  out,
  code,
}: {
  out: string
  code: number
}): 'passed' | 'failed' | 'pending' {
  if (/\b(pending|in_progress|queued)\b/i.test(out)) return 'pending'
  if (code !== 0 || /\bfail/i.test(out)) return 'failed'
  return 'passed'
}

// Dry-run's scripted sequence, so both terminal branches are genuinely walked
// across real rest/re-entry cycles rather than only the rest machinery.
export function scriptedCheck(
  attempts: number,
  outcome: 'passed' | 'failed' | 'pending',
): 'passed' | 'failed' | 'pending' {
  // 'pending' never resolves — the way to exercise the attempt bound (and the
  // rest/re-entry loop) without waiting for a real CI run.
  if (outcome === 'pending') return 'pending'
  if (outcome === 'passed') return attempts >= 1 ? 'passed' : 'pending'
  return attempts >= 2 ? 'failed' : 'pending'
}
