// Supervision, report-only.
//
// A task comes to rest half-finished more often than anyone notices, and the
// evidence that it does is that ~13-15 tasks in this corpus exist for no reason
// but to watch another task and nudge it. Their prompts read as specifications
// for this hook. What they cannot do is scale, and what a rule in the acting
// agent's own prompt cannot do is bind the agent that is already failing to
// follow it.
//
// This version NUDGES NOTHING. It applies the gate and says what it would have
// done, because a hook that reopens a task before its judgment has been scored
// trains the user to ignore hooks — and the gate has not been scored yet. That
// is what the log below is for.
//
// ── The gate ───────────────────────────────────────────────────────────────
//
// Three deterministic predicates, measured over 2,930 ride-end segments and
// reproduced verbatim here. Together they select ~20% of segments; alone, the
// union is what makes a judging step affordable at all. The predicate needs
// RECALL, not precision — it asks "could this be one of the cases?", and the
// judgment that follows (increment C) asks "is it, and what should happen?"
//
// The first predicate is a good gate signal and a BAD finding: of 235 human
// messages instructing a task to land, 97 saw no `landed` event before the next
// human message, and reading them shows that residue is almost entirely correct
// behavior — deferred deliberately, conditional wording, or interrupted. It is
// here to widen the net, not to accuse.
//
// ── The unit is the segment, not the ride ──────────────────────────────────
//
// Appendix A partitions `items[]` at each user message: the instruction,
// everything until the next human message, and the last non-user message in
// that span as the closing message. A segment can contain several rides.
// Evaluating per ride would multiply every measured rate by the number of rides
// in a segment, and the ~20% figure the cost argument rests on would stop
// meaning anything.
//
// ── Everything is evaluated AS OF THE FIRE ─────────────────────────────────
//
// A fire is dispatched a sweep (15s) plus a body's runtime after its ride
// closed, so the record read here has usually moved on. Judging the live record
// would systematically discard the case whose label matters most: a human
// replying inside that window opens a new segment, and "a human had to nudge"
// is precisely the positive class. So the segment is cut at `ctx.trigger.at`
// and the live state is recorded beside it as a flag.

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export const meta = { api: 1 }

// Verbatim from hooks.md Appendix A. Changing one of these invalidates the
// measured rates it was scored against.
const LAND_INSTRUCTION = /\b(then|and|,)\s*land\b|\bland it\b|\bcommit and land\b/i
const OFFER_TO_CONTINUE =
  /let me know if you|would you like me to|want me to (continue|proceed|keep going|go ahead)|shall i (continue|proceed)|should i (continue|proceed)|if you('d| would) like me to|say the word/i
const ENUMERATED = /(^|\n)\s*(?:[1-9][.)]|-|\*)\s+\S/g

const isUser = (it) => it.kind === 'message' && it.role === 'user'
// The turn's own closing word, not a subagent's: nested prose carries parentId.
const isClosing = (it) =>
  it.kind === 'message' && it.role === 'flow' && it.parentId === undefined

// The segment the fired ride belongs to, as the record stood at the fire.
function cutSegment(items, rideId) {
  const first = items.findIndex((it) => it.rideId === rideId)
  if (first < 0) return null
  // Walk back to the user message that opened this span.
  let start = first
  while (start > 0 && !isUser(items[start - 1])) start--
  while (start > 0 && isUser(items[start - 1])) start--
  // ...and forward to the next one, which opens the following segment.
  let end = first + 1
  while (end < items.length && !isUser(items[end])) end++
  const span = items.slice(start, end)
  // A batched turn delivers several user messages into one ride, so the
  // instruction is all of the leading ones.
  const instruction = span
    .filter(isUser)
    .map((it) => it.text ?? '')
    .join('\n\n')
  const closing = [...span].reverse().find(isClosing)
  const rides = [...new Set(span.filter((it) => it.rideId).map((it) => it.rideId))]
  return {
    instruction,
    closing: closing?.text ?? '',
    // Whether the fired ride is the last one in the span. A segment whose next
    // ride has already started has not closed, and the later fire will judge it.
    isLast: rides[rides.length - 1] === rideId,
    landed: span.some((it) => it.kind === 'event' && it.eventKind === 'landed'),
  }
}

function enumeratedCount(text) {
  return (text.match(ENUMERATED) ?? []).length
}

// One line per fire, whether or not the gate fired. The negatives are the whole
// point: recall cannot be computed from the positive class alone. (The labels
// themselves come from reading the corpus offline — this records what the gate
// SAW and DECIDED at fire time, which the corpus cannot reconstruct.)
async function log(ctx, row) {
  try {
    await mkdir(ctx.stateDir, { recursive: true })
    // Date-stamped rather than rotated: several hosts can run at once, and
    // size-triggered rotation performed by a single-file body is a multi-process
    // rename race.
    const file = path.join(
      ctx.stateDir,
      `supervise-${ctx.trigger.at.slice(0, 10)}.jsonl`,
    )
    // A run that is retried re-runs the body, and a body's own effects are not
    // deduped by the platform — so an errored fire would otherwise be counted
    // twice in the dataset it exists to produce.
    const tail = await readFile(file, 'utf8').catch(() => '')
    if (tail.includes(`"fireId":"${ctx.hook.fireId}"`)) return
    await appendFile(file, JSON.stringify(row) + '\n')
  } catch {
    // The log is evidence, not a dependency. A body that cannot write it still
    // reports its finding.
  }
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
  const all = task.items ?? []
  // As of the fire, not as of now.
  const items = all.filter((it) => it.at <= ctx.trigger.at)
  const segment = cutSegment(items, ctx.trigger.rideId)
  if (!segment) return log(ctx, { ...row, skipped: 'no-segment' })

  // A segment that has not closed will be judged by the fire of the ride that
  // does close it. `queued` is projected onto trailing user items the agent has
  // not read yet.
  const queued = all.some((it) => isUser(it) && it.queued)
  if (!segment.isLast || queued)
    return log(ctx, { ...row, skipped: 'segment-open', queued })
  // The ride that landed a task needs no supervision.
  if (segment.landed) return log(ctx, { ...row, skipped: 'landed' })

  const matched = []
  if (LAND_INSTRUCTION.test(segment.instruction)) matched.push('land-instruction')
  if (OFFER_TO_CONTINUE.test(segment.closing)) matched.push('offer-to-continue')
  if (enumeratedCount(segment.instruction) >= 2) matched.push('enumerated')

  // Recorded on every fire, including the ~80% that match nothing — those are
  // the false negatives any recall figure has to be computed against.
  await log(ctx, {
    ...row,
    matched,
    // Whether the record had already moved on by the time this ran, so a later
    // reading can tell a stale judgment from a live one.
    live: all.length === items.length,
    closingFirstLine: segment.closing.split('\n').find((l) => l.trim()) ?? '',
  })

  if (!matched.length) return

  ctx.report(
    `Would have checked whether this task is really finished — ${matched.join(', ')}.\n\n` +
      `Nudging is not armed yet, so nothing was sent. ` +
      `The gate selects roughly one ride-end segment in five; whether that is the ` +
      `right one is what the log in \`${ctx.stateDir}\` is for.`,
  )
}
