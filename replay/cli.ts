// Score a candidate hook against the labeled corpus.
//
//   npm run replay -- --hook .lander/hooks/landed/agent/review.js \
//                     --labels docs/tmp/corpus/labels-source.json \
//                     [--by agent] [--judge none|live] [--judge-limit N]
//                     [--deadline 480] [--concurrency 4] [--out docs/tmp/corpus]
//
// Two modes, and the difference matters more than the flag suggests:
//
//   --judge none  a SMOKE TEST. The only selective gate in a hook like this is
//                 its directory, and dispatch is what this does not simulate —
//                 so a judging-off run says the body runs over every real record
//                 without throwing, and what it skips. It is not a score, and
//                 the report says so at the top.
//   --judge live  the measurement. Real verdicts on labeled landings, which is
//                 what hooks.md §8 asks for before a judge is armed, supplied
//                 offline against history instead of waiting months for live
//                 verdicts to accrue at two a day.
//
// A live run spends real money over tens of minutes, and the Claude CLI caps a
// foreground command at ~600s and then backgrounds it into a task that dies with
// the turn — so it runs in CHUNKS. `--deadline` stops starting new cases and
// checkpoints; `--concurrency` shortens the wall clock; the answer cache means a
// resumed run pays only for what it has not already answered. The case list is
// drawn once and persisted, so the chunks compose into one run rather than each
// re-deriving a population.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { loadCases, projectFor, type Labels, type ReplayCase } from './corpus'
import {
  runCase,
  score,
  type CaseResult,
  type JudgeMode,
  type ReplayDeps,
} from './replay'
import type { AssistResult } from '../daemon/assist'

type Args = Record<string, string | true>

function parseArgs(argv: string[]): Args {
  const out: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[a.slice(2)] = next
      i++
    } else out[a.slice(2)] = true
  }
  return out
}

const str = (v: string | true | undefined, fallback = ''): string =>
  typeof v === 'string' ? v : fallback
const num = (v: string | true | undefined, fallback: number): number => {
  const n = Number(str(v))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const hook = str(args.hook)
  const labelsPath = str(args.labels)
  if (!hook || !labelsPath) {
    console.error(
      'usage: npm run replay -- --hook <path> --labels <path> [--by agent]\n' +
        '                        [--judge none|live] [--judge-limit N]\n' +
        '                        [--deadline <seconds>] [--concurrency <n>] [--out <dir>]',
    )
    process.exit(2)
  }

  const root = process.cwd()
  const hookPath = path.resolve(root, hook)
  // Which project's landings this hook would ever be dispatched for. Resolution
  // reads the target's own repository, so scoring a lander hook against another
  // project's landings measures a population it can never see.
  const project = projectFor(str(args.project) || undefined, root)
  if (!project) {
    console.error(`no project data found under ${path.join(root, 'data')}`)
    process.exit(2)
  }

  const labels = JSON.parse(await readFile(labelsPath, 'utf8')) as Labels
  const judge: JudgeMode = str(args.judge, 'none') === 'live' ? 'live' : 'none'
  const outDir = str(args.out, path.join(root, 'docs/tmp/corpus'))
  const stateDir = path.join(outDir, 'replay-state')
  const checkpoint = path.join(outDir, `replay-${path.basename(hook)}.json`)
  await mkdir(stateDir, { recursive: true })

  // Resume: the case list and every answer already paid for.
  type Checkpoint = {
    hook: string
    by: string
    // Part of the identity, not metadata. A judging-off run answers every case
    // and leaves nothing pending, so a later live run would resume into a
    // finished checkpoint and report "the judge ran on 0 cases" as a score.
    // The ANSWER cache is keyed by prompt and survives a mode change, so
    // nothing already paid for is paid for twice.
    judge: JudgeMode
    cases: ReplayCase[]
    done: Record<string, CaseResult>
    answers: Record<string, AssistResult>
  }
  let saved: Checkpoint | undefined
  try {
    saved = JSON.parse(await readFile(checkpoint, 'utf8')) as Checkpoint
  } catch {
    saved = undefined
  }

  const by = str(args.by, 'any')
  // The same run, resumable: same candidate, same population, same judging mode.
  // The case list is taken from the checkpoint rather than re-derived, so chunks
  // compose into one run instead of each drawing its own population.
  const resumable =
    saved?.hook === hook && saved.by === by && saved.judge === judge
  const cases = resumable ? saved!.cases : await loadCases({ project, labels, by })
  const done: Record<string, CaseResult> = resumable ? (saved!.done ?? {}) : {}
  // Answers outlive the run they were bought for: they are keyed by prompt, and
  // a re-scored candidate that asks the same question deserves the same answer
  // without paying again.
  const cache = new Map<string, AssistResult>(
    Object.entries(saved?.hook === hook ? (saved.answers ?? {}) : {}),
  )

  const key = (c: ReplayCase): string => `${c.task}\0${c.trigger.at}`
  const pending = cases.filter((c) => !done[key(c)])
  const limit = num(args['judge-limit'], pending.length)
  const deadline = num(args.deadline, Infinity) * 1000
  const concurrency = num(args.concurrency, judge === 'live' ? 4 : 1)
  const started = Date.now()

  console.log(
    `${cases.length} case(s) for ${project.slug}${by === 'any' ? '' : ` (by: ${by})`}; ` +
      `${pending.length} pending; judge=${judge}` +
      (Number.isFinite(deadline) ? `; deadline ${deadline / 1000}s` : ''),
  )

  const deps: ReplayDeps = { judge, stateDir, cache }
  const queue = pending.slice(0, limit)
  let cursor = 0
  let stopped = false

  const save = async (): Promise<void> => {
    await writeFile(
      checkpoint,
      JSON.stringify(
        { hook, by, judge, cases, done, answers: Object.fromEntries(cache) },
        null,
        2,
      ),
    )
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped) return
      const i = cursor++
      if (i >= queue.length) return
      if (Date.now() - started > deadline) {
        stopped = true
        return
      }
      const c = queue[i]
      const result = await runCase(hookPath, c, deps)
      done[key(c)] = result
      if ((i + 1) % 10 === 0) await save()
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  await save()

  const results = cases.map((c) => done[key(c)]).filter(Boolean)
  const report = score(results, judge)
  await writeFile(
    path.join(outDir, `report-${path.basename(hook)}.json`),
    JSON.stringify(report, null, 2),
  )

  console.log(`\nscored ${results.length} of ${cases.length} case(s)`)
  if (stopped)
    console.log(
      `STOPPED at the deadline with ${cases.length - results.length} left — ` +
        `re-run the same command to resume from the checkpoint`,
    )
  console.log(
    `fired ${report.firedCount} (${report.firedRate})` +
      `  false positives ${report.falsePositives}/${report.negatives} (${report.falsePositiveRate})` +
      `  precision floor ${report.precisionFloor}`,
  )
  console.log('\nlabeled positives:')
  for (const p of report.positives)
    console.log(
      `  ${p.fired ? 'HIT ' : 'MISS'} ${p.class.padEnd(12)} ${p.task.slice(0, 12).padEnd(13)} ${p.title.slice(0, 40)}`,
    )
  if (report.errors.length) console.log(`\n${report.errors.length} case(s) errored`)
  console.log('\ncaveats:')
  for (const c of report.caveats) console.log(`  - ${c}`)
  console.log(`\nfull report: ${path.join(outDir, `report-${path.basename(hook)}.json`)}`)
}

await main()
