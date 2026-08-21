// Self-review: judging a finished landing, and launching nothing.
//
// A task that lands has declared itself done. Across this corpus, 3.7% of
// landings were reopened for something a review could have caught — work left
// uncommitted, a fix that did not hold, a convention the project states and the
// work broke — and the agent's own closing message does not predict which: of 38
// landings whose summary admitted something unverified, 1 was reopened for
// quality, against 35 of 612 that admitted nothing. Admission is mildly
// ANTI-correlated with a real problem, which is why nothing below reads it.
//
// Two stages, and this is the first:
//
//   1. A cheap gate selects landings, a model judges each against what the task
//      was asked for and what it actually did, and the verdict is LOGGED.
//      Nothing is launched. `ctx.launch` exists and is deliberately not called.
//   2. Once those verdicts have been compared with what a human would have done,
//      a positive verdict launches a real review task, with a tool envelope and
//      a transcript, to do the reviewing.
//
// The split is the design's rule (hooks.md §8): a judge is measured before it is
// armed, exactly as a destructive verb ships report-only first. And the two
// stages are not the same judge — this one reasons over the record in a
// write-clamped one-shot; stage 2 would read the working tree — so measuring
// this one licenses the gate and this judge, not that one.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const meta = { api: 1 }

// What the judge may be shown. The span a landing closes is usually small — a
// median of 5 tool calls and no edit hunks at all — but the tail runs to 158
// calls and 54 KB, and a one-shot has no cache, so every token is paid fresh.
const MAX_TOOLS = 80
const MAX_HUNK_BYTES = 12_000
const MAX_INSTRUCTION = 6_000

const isUser = (it) => it.kind === 'message' && it.role === 'user'

// The span this landing closes: from the human message that opened it, to the
// landing itself. The unit is the instruction, not the ride — several rides can
// serve one instruction, and judging per ride would ask the same question of the
// same work repeatedly.
function cutSpan(items, at) {
  const end = items.findIndex(
    (it) => it.kind === 'event' && it.eventKind === 'landed' && it.at >= at,
  )
  if (end < 0) return null
  // Two walks, and the second is the one it is easy to leave out. The first
  // steps back over everything the task did; the second steps back over the RUN
  // of human messages that opened it — the queue delivers several as one turn —
  // so the instruction is inside the span rather than one item before it.
  let start = end
  while (start > 0 && !isUser(items[start - 1])) start--
  while (start > 0 && isUser(items[start - 1])) start--
  return {
    instruction: items
      .slice(start, end)
      .filter(isUser)
      .map((it) => it.text ?? '')
      .join('\n\n'),
    body: items.slice(start, end),
    // A human who has already replied has taken the work back; there is nothing
    // for a review of the previous instruction to add, and the platform would
    // refuse an action on this fire anyway. Checking here saves the judgment,
    // not just the action.
    repliedSince: items.some((it) => isUser(it) && it.at > at),
  }
}

// What the task actually did, which is what hooks.md §1 says a completeness
// judge must read instead of the self-report.
//
// The record is richer than the design assumes, and it is PROVIDER-SPLIT. A
// Claude edit carries `edits` — the before/after hunks, capped at 4000 chars a
// side — so for a Claude target the record contains an approximate diff. A Codex
// edit arrives as a `FileChange` item whose whole input is "<verb> <path>" and
// carries no hunks at all. The judge is told which of the two it is looking at,
// so it is not invited to reason about hunks it was never given.
function describeWork(body) {
  const tools = body.filter((it) => it.kind === 'tool')
  const kept = tools.slice(-MAX_TOOLS)
  let hunkBudget = MAX_HUNK_BYTES
  let hunksShown = false

  const lines = kept.map((it) => {
    const input = String(it.inputFull ?? it.input ?? '').replace(/\s+/g, ' ').slice(0, 300)
    const status = it.status && it.status !== 'ok' ? ` [${it.status}]` : ''
    let line = `${it.name}${status}: ${input}`
    for (const e of it.edits ?? []) {
      const hunk = `\n    - was: ${String(e.old ?? '').slice(0, 600)}\n    + now: ${String(e.new ?? '').slice(0, 600)}`
      if (hunk.length > hunkBudget) continue
      hunkBudget -= hunk.length
      hunksShown = true
      line += hunk
    }
    return line
  })

  return {
    lines,
    dropped: tools.length - kept.length,
    hunksShown,
    commits: tools.filter((it) =>
      /(^|[;&|]\s*|\(\s*)git\s+(-\S+\s+|--\S+(=\S+)?\s+)*commit\b/.test(
        String(it.inputFull ?? it.input ?? ''),
      ),
    ).length,
  }
}

// Stated to the model and parsed strictly, because an unparseable verdict is
// INERT (hooks.md §9): a model that answers off-format produces no action rather
// than an arbitrary one, so the parse defaults to `unclear` and `unclear` never
// acts.
const VERDICT = /^\s*VERDICT:\s*(complete|incomplete|unclear)\b/im
const BECAUSE = /^\s*BECAUSE:\s*(.+)$/im

function parseVerdict(text) {
  const m = VERDICT.exec(text ?? '')
  if (!m) return { verdict: 'unclear', unparseable: true }
  return {
    verdict: m[1].toLowerCase(),
    because: (BECAUSE.exec(text ?? '')?.[1] ?? '').trim().slice(0, 400),
  }
}

function judgePrompt({ instruction, work, provider }) {
  return [
    'You are judging whether a finished software task did what it was asked to do.',
    'You have everything you need below. Do not use tools; do not explore.',
    '',
    'Answer in exactly this form, and nothing else:',
    'VERDICT: complete|incomplete|unclear',
    'BECAUSE: <one sentence>',
    '',
    'Use `incomplete` only when the instruction asked for something specific that',
    'the record below shows was not done — work described but never performed,',
    'edits made and never committed when committing was asked for, a check the',
    'instruction required and no evidence of it. Do not judge code quality, and do',
    'not speculate about what is missing from the record: judge what was ASKED',
    'against what was DONE. Use `unclear` when the two do not settle it.',
    '',
    'TWO THINGS THE RECORD DOES NOT CONTAIN, so their absence is not evidence:',
    '- What the agent SAID. Only its actions are listed. If the instruction asked',
    '  for an explanation, a summary, a report, a verdict or any other written',
    '  answer, you cannot tell whether it was given, and must not call the task',
    '  incomplete for it. This is deliberate: the agent’s own account of its work',
    '  does not predict whether the work was done, so you are not shown it.',
    '- The landing itself. This task HAS landed — that is why you are being asked —',
    '  so never treat a missing land, or a missing final command, as unfinished.',
    '',
    provider === 'codex'
      ? 'NOTE: this record lists file changes by path only. You cannot see what changed inside a file, so do not infer that an edit was wrong or absent from its absence here.'
      : work.hunksShown
        ? 'The record includes before/after excerpts for some edits.'
        : 'The record lists file changes without excerpts.',
    work.dropped > 0
      ? `NOTE: ${work.dropped} earlier tool call(s) are omitted; you are seeing the most recent ${MAX_TOOLS}.`
      : '',
    '',
    '--- WHAT IT WAS ASKED TO DO ---',
    instruction.slice(0, MAX_INSTRUCTION),
    '',
    '--- WHAT IT ACTUALLY DID ---',
    work.lines.join('\n') || '(no tool calls in this span)',
  ]
    .filter(Boolean)
    .join('\n')
}

// One line per fire, whether or not the gate fired and whether or not a judge
// ran. The negatives are the point: a rate cannot be read from the positive
// class alone.
async function log(ctx, row) {
  try {
    await mkdir(ctx.stateDir, { recursive: true })
    const file = path.join(ctx.stateDir, `review-${ctx.trigger.at.slice(0, 10)}.jsonl`)
    const tail = await readFile(file, 'utf8').catch(() => '')
    // A row is a direct body effect, which the platform's retry guarantee
    // excludes — and the two attempt-worthy outcomes retry up to five times, so
    // left alone the log would over-count exactly the fires that had trouble.
    if (tail.includes(`"fireId":"${ctx.hook.fireId}"`)) return
    await appendFile(file, JSON.stringify(row) + '\n')
  } catch {
    // The log is evidence, not a dependency.
  }
}

// A verdict already reached for this fire, so a retry re-reads rather than
// re-judges. Without it, a fire that fails after judging pays for the model
// again on every one of up to five attempts.
async function cached(ctx) {
  try {
    return JSON.parse(
      await readFile(path.join(ctx.stateDir, `verdict-${ctx.hook.fireId}.json`), 'utf8'),
    )
  } catch {
    return null
  }
}

async function cache(ctx, verdict) {
  try {
    await mkdir(ctx.stateDir, { recursive: true })
    // writeFile, not appendFile: two writes for one fire would concatenate into
    // unparseable JSON and the cache would silently miss, re-paying for the
    // model on every retry — the one thing it exists to prevent.
    await writeFile(
      path.join(ctx.stateDir, `verdict-${ctx.hook.fireId}.json`),
      JSON.stringify(verdict),
    )
  } catch {}
}

export default async function onTurn(ctx) {
  const row = {
    fireId: ctx.hook.fireId,
    target: ctx.target.id,
    at: ctx.trigger.at,
    by: ctx.trigger.by,
  }

  const task = await ctx.target.read()
  const items = task.items ?? []
  const span = cutSpan(items, ctx.trigger.at)
  if (!span) return log(ctx, { ...row, skipped: 'no-span' })
  // The human took it back before this fire was dispatched.
  if (span.repliedSince) return log(ctx, { ...row, skipped: 'replied-since' })

  const work = describeWork(span.body)
  // Nothing was done in this span, so there is nothing for a completeness judge
  // to read. A cheap skip, and it costs none of the labelled cases this hook is
  // for.
  if (!work.lines.length) return log(ctx, { ...row, skipped: 'empty-span' })

  const provider = task.flow === 'codex' ? 'codex' : 'claude'
  const verdict =
    (await cached(ctx)) ??
    (await (async () => {
      const answer = await ctx.assist(
        judgePrompt({ instruction: span.instruction, work, provider }),
      )
      if (!answer.ok) return { verdict: 'unavailable', error: answer.error }
      return { ...parseVerdict(answer.text), raw: answer.text.slice(0, 600) }
    })())
  if (verdict.verdict !== 'unavailable') await cache(ctx, verdict)

  await log(ctx, {
    ...row,
    provider,
    tools: work.lines.length,
    dropped: work.dropped,
    commits: work.commits,
    hunks: work.hunksShown,
    verdict: verdict.verdict,
    because: verdict.because ?? '',
    unparseable: verdict.unparseable ?? false,
    judgeError: verdict.error ?? '',
  })

  // Nothing is launched. The verdict is evidence until it has been compared with
  // what a human would have done — hooks.md §8, and §8a's arming preconditions.
  if (verdict.verdict === 'incomplete')
    ctx.report(
      `Judged this landing **incomplete** — ${verdict.because || 'no reason given'}\n\n` +
        `Nothing was launched: self-review is judging and logging while its ` +
        `verdicts are scored, not acting on them.`,
    )
}
