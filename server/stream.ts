// The pure stream-json reducer: it folds one line of claude's CLI output into
// the activity Steps it contributes and any final reply text it carries. Kept
// free of I/O so the same reduction serves both a live child process and a run
// read back from its on-disk log — and so it can be unit-tested in isolation.

export type Step = {
  kind: 'text' | 'tool_use' | 'tool_result'
  text?: string
  tool?: string
  input?: string
  // The tool call's id, carried on both the tool_use step and its matching
  // tool_result step so the UI can pair a call with its outcome.
  toolUseId?: string
  // text/tool_use only: the id of the model inference (assistant message) that
  // produced this block. Every text and tool_use block from one inference shares
  // it — including a parallel batch of tool calls, which is exactly one inference
  // emitting several tool_use blocks at once. So a change in inferenceId between
  // consecutive steps marks a turn boundary (the model saw the prior results and
  // ran again); the UI rules a line there. It is NOT a parallel-batch marker:
  // within one inference the model interleaves text and tool calls freely, and
  // the stream interleaves each call's result right after it, so adjacency tells
  // you nothing — only the inference id (corroborated by a flat per-message
  // usage/cache_read) distinguishes one turn from the next. Absent on tool_result
  // steps (harness output, attributed to the preceding inference by position) and
  // on steps recorded before this field existed.
  inferenceId?: string
  // tool_use only: the call rendered as a settings.json permission string
  // (e.g. `Bash(npm run build)`), used to seed the "allow" popup.
  rule?: string
  // tool_use only, for the file-writing tools (Edit/Write/MultiEdit): the change
  // as before/after hunks, so the UI can reveal a diff under the chip. One hunk
  // per edit (MultiEdit has several); Write has a single hunk with empty `old`.
  // Absent for every other tool.
  edits?: { old: string; new: string }[]
  // tool_result only: whether the call errored. `blocked` means the call was
  // refused before it ran (permission gate, Bash safety check, or sandbox file
  // block) — set during a turn's terminal result event from its authoritative
  // permission_denials list, not inferred from the result text. Absent means the
  // call ran; the UI reads that as allowed.
  isError?: boolean
  blocked?: boolean
  createdAt: string
}

// The token usage a turn consumed. Accumulated live as the turn streams — each
// `assistant` event carries its inference's usage, which the reducer sums across
// the turn's inferences — then finalized by the run's terminal `result` event,
// which reports the authoritative cumulative totals. `input` is the fresh,
// uncached input and `cacheCreation` the fresh input that was also written to
// cache — both processed at full price this turn; `cacheRead` is the discounted
// re-read of cached context. The full prompt size across the turn's inferences is
// the three summed. `model` is the session's driving (main-agent) model — see
// reduceStreamLine's `drivingModel`. `costUsd` is the turn's dollar cost (the
// result event's `total_cost_usd`, summing every model the turn touched); it
// arrives only with that final event, so it's absent until the turn lands. The
// UI shows the most recent turn's counts in the corner, updating as they stream,
// and can sum them across the task.
export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  model?: string
  costUsd?: number
}

// Reduce a tool call's input to a one-line summary for the activity chip. Picks
// the most identifying string field, collapses whitespace, and caps the length.
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const v =
    str('file_path') ||
    str('path') ||
    str('command') ||
    str('pattern') ||
    str('query') ||
    str('url') ||
    str('description') ||
    JSON.stringify(i)
  const flat = v.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? flat.slice(0, 200) + '…' : flat
}

// Render a tool call as a settings.json-style permission rule, e.g.
// `Bash(npm run build)` or `Read(/path/to/file)`. Keys off the same identifying
// field as summarizeToolInput but leaves it untruncated, so the popup can show —
// and let the user grant — the exact invocation. A tool with no obvious
// specifier becomes a bare tool name.
export function toolRule(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name
  const i = input as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const spec =
    str('command') ||
    str('file_path') ||
    str('path') ||
    str('pattern') ||
    str('query') ||
    str('url')
  return spec ? `${name}(${spec})` : name
}

// Pull the before/after hunks out of a file-writing tool's input so the UI can
// show its diff: Edit is one hunk (old_string → new_string), MultiEdit is one
// per entry, and Write is a single hunk against an empty original. Returns
// undefined for any other tool. Each side is capped so a giant edit can't bloat
// the task file; the UI only needs a readable peek.
export function diffEdits(
  name: string,
  input: unknown,
): { old: string; new: string }[] | undefined {
  if (!input || typeof input !== 'object') return undefined
  const i = input as Record<string, unknown>
  const cap = (v: unknown) => {
    const s = typeof v === 'string' ? v : ''
    return s.length > 4000 ? s.slice(0, 4000) + '\n…' : s
  }
  if (name === 'Edit') {
    if (typeof i.old_string === 'string' && typeof i.new_string === 'string')
      return [{ old: cap(i.old_string), new: cap(i.new_string) }]
  } else if (name === 'Write') {
    if (typeof i.content === 'string') return [{ old: '', new: cap(i.content) }]
  } else if (name === 'MultiEdit') {
    if (Array.isArray(i.edits))
      return i.edits
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({
          old: cap((e as Record<string, unknown>).old_string),
          new: cap((e as Record<string, unknown>).new_string),
        }))
  }
  return undefined
}

// Concatenate a tool_result block's content (a plain string or an array of
// content blocks) into its raw text, preserving newlines.
export function rawToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((b) => (b && typeof b === 'object' ? String((b as any).text ?? '') : ''))
      .join('')
  return ''
}

// A short text peek at a tool_result for the activity trace. Keeps line breaks
// so multi-line output stays readable, but caps the peek at 200 characters or 3
// lines, whichever comes first. A character cap appends an inline ellipsis; a
// line cap puts the ellipsis on its own line.
export function summarizeToolResult(content: unknown): string {
  let text = rawToolResultText(content).trim()
  let charCapped = false
  if (text.length > 200) {
    text = text.slice(0, 200)
    charCapped = true
  }
  const lines = text.split('\n')
  if (lines.length > 3) return lines.slice(0, 3).join('\n') + '\n…'
  return charCapped ? text + '…' : text
}

// Pick the busiest model out of a result event's `modelUsage` map (keyed by
// model id, each value carrying that model's `outputTokens`): the one that
// generated the most output. Only a fallback for the turn's headline model now —
// the caller prefers the session's driving model from the init event, because a
// tool-heavy subagent on a cheaper model can out-emit the main agent and would
// otherwise hijack the attribution. Used when no init event was seen (e.g. a run
// reattached past it). Undefined when the map is absent or empty.
function dominantModel(modelUsage: unknown): string | undefined {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined
  let best: string | undefined
  let bestOut = -1
  for (const [name, mu] of Object.entries(modelUsage as Record<string, unknown>)) {
    const out =
      mu && typeof mu === 'object' && typeof (mu as any).outputTokens === 'number'
        ? ((mu as any).outputTokens as number)
        : 0
    if (out > bestOut) {
      bestOut = out
      best = name
    }
  }
  return best
}

// Pull the four token counts out of a raw `usage` object (an `assistant` event's
// per-inference usage or a `result` event's cumulative totals — same field
// names), defaulting any missing field to zero. `model` is supplied by the
// caller: the inference's model for an assistant event, the dominant model for a
// result event.
function parseUsage(u: Record<string, unknown>, model?: string): Usage {
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0)
  return {
    input: n('input_tokens'),
    output: n('output_tokens'),
    cacheRead: n('cache_read_input_tokens'),
    cacheCreation: n('cache_creation_input_tokens'),
    model,
  }
}

// Add one inference's usage onto the turn's running total. Token counts sum; the
// model is the latest inference's (turns are effectively single-model, and the
// result event finalizes the true dominant model at turn end regardless). Cost
// sums too, staying undefined until a snapshot carries one (only the result event
// does), so a still-streaming turn reports no cost rather than a misleading zero.
export function addUsage(acc: Usage | undefined, next: Usage): Usage {
  if (!acc) return next
  return {
    input: acc.input + next.input,
    output: acc.output + next.output,
    cacheRead: acc.cacheRead + next.cacheRead,
    cacheCreation: acc.cacheCreation + next.cacheCreation,
    model: next.model ?? acc.model,
    costUsd:
      acc.costUsd === undefined && next.costUsd === undefined
        ? undefined
        : (acc.costUsd ?? 0) + (next.costUsd ?? 0),
  }
}

// Parse one line of claude's stream-json output into the activity steps it
// contributes and any final reply text it carries. Pure — given a line, it
// returns what to append — so the same reduction serves both a live child
// process and a run read back from its on-disk log.
export function reduceStreamLine(
  line: string,
  at: string,
): {
  steps: Step[]
  finalText?: string
  blockedIds?: string[]
  usage?: Usage
  // The id of the inference `usage` belongs to, when it's an assistant event's
  // per-inference snapshot. An inference's usage repeats across its content-block
  // events, so the reducer counts it once per distinct id. Absent on a result
  // event's total (which is authoritative — see `usageFinal`).
  usageInferenceId?: string
  // True when `usage` is the result event's authoritative turn total, which
  // replaces the streamed running estimate rather than adding to it.
  usageFinal?: boolean
  // The session's driving (main-agent) model, announced by the `system`/`init`
  // event at the top of the run. The caller holds onto it and stamps it as every
  // turn's usage model, so the headline model is always the one that ran the
  // session — not whichever model logged the most output tokens, which a
  // tool-heavy subagent on a cheaper model can skew (see dominantModel).
  drivingModel?: string
} {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return { steps: [] }
  }
  const steps: Step[] = []
  let finalText: string | undefined
  let blockedIds: string[] | undefined
  let usage: Usage | undefined
  let usageInferenceId: string | undefined
  let usageFinal: boolean | undefined
  let drivingModel: string | undefined
  if (ev.type === 'system' && ev.subtype === 'init') {
    // The init event names the session's configured (main-agent) model.
    if (typeof ev.model === 'string') drivingModel = ev.model
  } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    const inferenceId =
      typeof ev.message.id === 'string' ? ev.message.id : undefined
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text) {
        steps.push({ kind: 'text', text: block.text, inferenceId, createdAt: at })
        finalText = block.text
      } else if (block.type === 'tool_use') {
        steps.push({
          kind: 'tool_use',
          tool: block.name,
          input: summarizeToolInput(block.input),
          toolUseId: block.id,
          inferenceId,
          rule: toolRule(block.name, block.input),
          edits: diffEdits(block.name, block.input),
          createdAt: at,
        })
      }
    }
    // The event carries this inference's running usage; report it (tagged with
    // the inference id) so the reducer can sum it across the turn as it streams.
    if (ev.message.usage && typeof ev.message.usage === 'object') {
      const model =
        typeof ev.message.model === 'string' ? ev.message.model : undefined
      usage = parseUsage(ev.message.usage as Record<string, unknown>, model)
      usageInferenceId = inferenceId
    }
  } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_result') {
        steps.push({
          kind: 'tool_result',
          text: summarizeToolResult(block.content),
          toolUseId: block.tool_use_id,
          isError: block.is_error === true,
          createdAt: at,
        })
      }
    }
  } else if (ev.type === 'result') {
    if (typeof ev.result === 'string') finalText = ev.result
    if (Array.isArray(ev.permission_denials))
      blockedIds = ev.permission_denials
        .map((d: any) => d?.tool_use_id)
        .filter((id: unknown): id is string => typeof id === 'string')
    if (ev.usage && typeof ev.usage === 'object') {
      // This total is authoritative: it replaces the running estimate at turn
      // end. The model here is only a fallback — the caller stamps the session's
      // driving model over it (dominantModel matters solely when no init was seen).
      usage = parseUsage(ev.usage as Record<string, unknown>, dominantModel(ev.modelUsage))
      // The turn's dollar cost across every model it touched; only the result
      // event reports it.
      if (typeof ev.total_cost_usd === 'number') usage.costUsd = ev.total_cost_usd
      usageFinal = true
    }
  }
  return { steps, finalText, blockedIds, usage, usageInferenceId, usageFinal, drivingModel }
}
