// DRAFT of the next supervision body — the stage that judges and logs a verdict
// without acting on it. Held in docs/tmp (gitignored) rather than in .lander/
// while a sibling task rewrites history, so the working tree stays clean for it.
//
// Diff from the shipped body is three things:
//   1. a gated segment is handed to ctx.assist instead of ending at ctx.report;
//   2. the verdict, and how it was reached, join the JSONL row;
//   3. nothing acts. ctx.nudge and ctx.land exist and are not called.
//
// That third point is the stage, not an oversight. hooks.md §8: a judge is
// measured before it is armed, against real segments, so the verdicts can be
// compared with what a human would have done. Arming on the first verdicts a
// model ever produces is the destructive-verb mistake with the destruction one
// step further away — and the log this produces is what §10's harness wants as
// input anyway.

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const meta = { api: 1 }

// Verbatim from hooks.md Appendix A. Changing one invalidates the rates it was
// scored against.
const LAND_INSTRUCTION = /\b(then|and|,)\s*land\b|\bland it\b|\bcommit and land\b/i
const OFFER_TO_CONTINUE =
  /let me know if you|would you like me to|want me to (continue|proceed|keep going|go ahead)|shall i (continue|proceed)|should i (continue|proceed)|if you('d| would) like me to|say the word/i
const ENUMERATED = /(^|\n)\s*(?:[1-9][.)]|-|\*)\s+\S/g

const isUser = (it) => it.kind === 'message' && it.role === 'user'
const isClosing = (it) =>
  it.kind === 'message' && it.role === 'flow' && it.parentId === undefined
// A nudge this hook already sent. Not a segment boundary — boundaries are human
// messages, or the unit stops being the one every rate was measured over — but
// it does mean this span has already been spoken to.
const isOwnNudge = (it, path) =>
  it.kind === 'message' && it.role === 'hook' && it.from?.path === path

function cutSegment(items, rideId, hookPath) {
  const first = items.findIndex((it) => it.rideId === rideId)
  if (first < 0) return null
  let start = first
  while (start > 0 && !isUser(items[start - 1])) start--
  while (start > 0 && isUser(items[start - 1])) start--
  let end = first + 1
  while (end < items.length && !isUser(items[end])) end++
  const span = items.slice(start, end)
  const instruction = span
    .filter(isUser)
    .map((it) => it.text ?? '')
    .join('\n\n')
  const closing = [...span].reverse().find(isClosing)
  const rides = [...new Set(span.filter((it) => it.rideId).map((it) => it.rideId))]
  return {
    instruction,
    closing: closing?.text ?? '',
    isLast: rides[rides.length - 1] === rideId,
    landed: span.some((it) => it.kind === 'event' && it.eventKind === 'landed'),
    alreadyNudged: span.some((it) => isOwnNudge(it, hookPath)),
  }
}

const enumeratedCount = (text) => (text.match(ENUMERATED) ?? []).length

// ── The verdict grammar ────────────────────────────────────────────────────
//
// Stated to the model and parsed strictly, because hooks.md §9 makes one
// platform-level rule for any judging body: an unparseable verdict is INERT. A
// model that answers off-format produces no action rather than an arbitrary one,
// so the parse defaults to `unclear` and `unclear` never acts.
const VERDICT = /^\s*VERDICT:\s*(finished|unfinished|unclear)\b/im
const BECAUSE = /^\s*BECAUSE:\s*(.+)$/im

function parseVerdict(text) {
  const verdict = VERDICT.exec(text ?? '')
  if (!verdict) return { verdict: 'unclear', unparseable: true }
  return {
    verdict: verdict[1].toLowerCase(),
    because: (BECAUSE.exec(text ?? '')?.[1] ?? '').trim().slice(0, 400),
  }
}

// §1: do not rest a verdict on the agent's self-report. The gate may use it —
// offer-to-continue reads exactly that prose — but the judge is asked to weigh
// the closing message against what was actually ASKED, which is the instruction.
function judgePrompt({ instruction, closing }) {
  return [
    'You are judging whether a software task actually finished what it was asked to do.',
    'You have everything you need below. Do not use tools; do not explore.',
    '',
    'Answer in exactly this form, and nothing else:',
    'VERDICT: finished|unfinished|unclear',
    'BECAUSE: <one sentence>',
    '',
    'Use `unfinished` only when the instruction asked for something specific that the',
    'closing message shows was not done. A task that deliberately stopped to ask its',
    'human a question it cannot answer itself is `finished` for this purpose — it is',
    'waiting on a person, not idling. Use `unclear` when the two do not settle it.',
    '',
    '--- THE INSTRUCTION IT WAS GIVEN ---',
    instruction.slice(0, 6000),
    '',
    '--- HOW IT ENDED ---',
    closing.slice(0, 6000),
  ].join('\n')
}

// One line per fire, whether or not the gate fired and whether or not a judge
// ran. The negatives are the point: recall cannot be computed from the positive
// class alone.
async function log(ctx, row) {
  try {
    await mkdir(ctx.stateDir, { recursive: true })
    const file = path.join(
      ctx.stateDir,
      `supervise-${ctx.trigger.at.slice(0, 10)}.jsonl`,
    )
    const tail = await readFile(file, 'utf8').catch(() => '')
    if (tail.includes(`"fireId":"${ctx.hook.fireId}"`)) return
    await appendFile(file, JSON.stringify(row) + '\n')
  } catch {
    // The log is evidence, not a dependency.
  }
}

// A verdict already reached for this fire, so a retry re-reads rather than
// re-judges. An assist is a direct body effect, which hooks.md §8 excludes from
// the platform's retry guarantee — without this, a fire that failed after
// judging pays for the model again on every one of up to five attempts.
async function cachedVerdict(ctx) {
  try {
    const raw = await readFile(
      path.join(ctx.stateDir, `verdict-${ctx.hook.fireId}.json`),
      'utf8',
    )
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function cacheVerdict(ctx, verdict) {
  try {
    await mkdir(ctx.stateDir, { recursive: true })
    await appendFile(
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
    ride: ctx.trigger.rideId,
    outcome: ctx.trigger.outcome,
  }

  const task = await ctx.target.read()
  const items = task.items ?? []
  const segment = cutSegment(items, ctx.trigger.rideId, ctx.hook.path)
  if (!segment) return log(ctx, { ...row, skipped: 'no-segment' })
  if (!segment.isLast) return log(ctx, { ...row, skipped: 'segment-open' })
  if (segment.landed) return log(ctx, { ...row, skipped: 'landed' })
  // This span has already been spoken to. Without this the same finding would be
  // re-judged and re-reported on every subsequent ride under one instruction,
  // and the runaway bound would become the routine terminating condition rather
  // than the backstop it is.
  if (segment.alreadyNudged) return log(ctx, { ...row, skipped: 'already-nudged' })

  const matched = []
  if (LAND_INSTRUCTION.test(segment.instruction)) matched.push('land-instruction')
  if (OFFER_TO_CONTINUE.test(segment.closing)) matched.push('offer-to-continue')
  if (enumeratedCount(segment.instruction) >= 2) matched.push('enumerated')

  const live = !items.some((it) => it.at > ctx.trigger.at)
  const closingFirstLine = segment.closing.split('\n').find((l) => l.trim()) ?? ''

  // ~80% of segments end here, having cost a process and no tokens.
  if (!matched.length)
    return log(ctx, { ...row, matched, live, closingFirstLine })

  const cached = await cachedVerdict(ctx)
  const judged =
    cached ??
    (await (async () => {
      const answer = await ctx.assist(judgePrompt(segment))
      if (!answer.ok) return { verdict: 'unavailable', error: answer.error }
      const parsed = parseVerdict(answer.text)
      return { ...parsed, raw: answer.text.slice(0, 600) }
    })())
  if (!cached) await cacheVerdict(ctx, judged)

  await log(ctx, {
    ...row,
    matched,
    live,
    closingFirstLine,
    verdict: judged.verdict,
    because: judged.because ?? '',
    unparseable: judged.unparseable ?? false,
    judgeError: judged.error ?? '',
    fromCache: !!cached,
  })

  // Nothing acts. The verdict is evidence until it has been compared with what a
  // human would have done — hooks.md §8, and §8a's arming precondition.
  if (judged.verdict === 'unfinished')
    ctx.report(
      `Judged this task **unfinished** — ${judged.because || 'no reason given'}\n\n` +
        `Gate: ${matched.join(', ')}. Nothing was sent: supervision is judging and ` +
        `logging while its verdicts are scored, not acting on them.`,
    )
}
