// The pure stream-json reducer: it folds one line of claude's CLI output into
// the activity Steps it contributes and any final reply text it carries. Kept
// free of I/O so the same reduction serves both a live child process and a run
// read back from its on-disk log — and so it can be unit-tested in isolation.

import type { Step, Usage } from '../shared/stream'
import { fullToolInput, summarizeToolInput, toolRule, diffEdits, rawToolResultText, summarizeToolResult } from './stream'
import type { ContextUpdate } from '../shared/context'

// An Agent call's expanded input: its `<type>: <description>` line, then the
// prompt the subagent was given, which the chip otherwise never shows. The cap
// is looser than fullToolInput's, since a prompt is the whole brief — about one
// in ten runs past 4k.
export function agentInputFull(input: unknown): string {
  const head = fullToolInput(input)
  const prompt =
    input && typeof input === 'object' ? (input as Record<string, unknown>).prompt : undefined
  if (typeof prompt !== 'string' || !prompt) return head
  const full = `${head}\n\n${prompt}`
  return full.length > 16000 ? full.slice(0, 16000) + '\n…' : full
}

// The subagent's report from an Agent result's structured `tool_use_result`
// (its `content` text blocks), capped like the prompt. Undefined for any other
// result.
function agentReport(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const r = result as Record<string, unknown>
  if (typeof r.agentId !== 'string' || !Array.isArray(r.content)) return undefined
  const text = rawToolResultText(r.content).trim()
  if (!text) return undefined
  return text.length > 16000 ? text.slice(0, 16000) + '\n…' : text
}

// Pull the four token counts out of a raw `usage` object (an `assistant` event's
// per-inference usage or a `result` event's cumulative totals — same field
// names), defaulting any missing field to zero. `model` is supplied by the
// caller for an assistant event (the inference's model); a result event's total
// carries none, since the caller stamps the session's driving model onto it.
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
  // session — not a tool-heavy subagent on a cheaper model that happened to emit
  // more output.
  drivingModel?: string
  // Set on the `system`/`init` event. The one failure observed to precede the
  // session recording the user message (a missing --resume session) ends
  // before init, and an API failure records it — so a run that got this far
  // has the message in its transcript.
  turnStarted?: true
  // The text of the assistant message the main agent's CLI writes in place of a
  // reply when the API call fails (`is_api_error_message`) — e.g. "Failed to
  // authenticate: OAuth session expired…". The CLI prints it on stdout; stderr
  // carries at most a terse diagnostic, and for an expired login nothing.
  apiError?: string
  // When a `rate_limit_event` reports the session limit was *rejected* (the turn
  // was refused outright, not just warned), the ISO time the limit resets —
  // claude sends it as `rate_limit_info.resetsAt`, a Unix epoch in seconds. The
  // run reducer carries it onto a rate-limit wedge's `retry`, so the UI can offer
  // to retry when the limit lifts rather than firing into the same wall. Absent on
  // any other line, and on non-rejecting rate events (warnings still allow the turn).
  rateLimitResetsAt?: string
  // The session's running totals from a result event: `total_cost_usd` and the
  // token count summed across `modelUsage`. Both cover every turn of the
  // session, not just this one (a resumed session restores them), so they are
  // reported apart from `usage` for the flow to difference against the previous
  // turn's — see sessionCost.
  sessionTotals?: SessionTotals
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
  let turnStarted: true | undefined
  let apiError: string | undefined
  let rateLimitResetsAt: string | undefined
  let sessionTotals: SessionTotals | undefined
  if (ev.type === 'system' && ev.subtype === 'init') {
    turnStarted = true
    if (typeof ev.model === 'string') drivingModel = ev.model
  } else if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
    const metadata = ev.compact_metadata
    const context: ContextUpdate = { action: 'compaction', phase: 'completed' }
    if (metadata?.trigger === 'auto' || metadata?.trigger === 'manual')
      context.trigger = metadata.trigger
    for (const [source, target] of [
      ['pre_tokens', 'beforeTokens'],
      ['post_tokens', 'afterTokens'],
      ['duration_ms', 'durationMs'],
    ] as const) {
      const value = metadata?.[source]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
        context[target] = value
    }
    steps.push({ kind: 'context', context, createdAt: at })
  } else if (
    ev.type === 'system' && ev.subtype === 'status' &&
    (ev.status === 'compacting' || ev.status === 'requesting' || ev.status === null)
  ) {
    steps.push({
      kind: 'context',
      context: { action: 'compaction', phase: ev.status === 'compacting' ? 'started' : 'idle' },
      createdAt: at,
    })
  } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    const inferenceId =
      typeof ev.message.id === 'string' ? ev.message.id : undefined
    const parentToolUseId =
      typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : undefined
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text) {
        steps.push({
          kind: 'text',
          text: block.text,
          inferenceId,
          parentToolUseId,
          createdAt: at,
        })
        // Only the main agent's text is the turn's reply; a subagent's prose stays
        // inside its own trace and must not overwrite the message's reply text.
        if (!parentToolUseId) finalText = block.text
        if (!parentToolUseId && ev.is_api_error_message === true)
          apiError = block.text
      } else if (block.type === 'tool_use') {
        const input = summarizeToolInput(block.input)
        const inputFull =
          block.name === 'Agent'
            ? agentInputFull(block.input)
            : fullToolInput(block.input)
        steps.push({
          kind: 'tool_use',
          tool: block.name,
          input,
          // Keep the untruncated input only when it says more than the one-line
          // summary already shows (multi-line or truncated); a short single-line
          // input needs no second copy.
          ...(inputFull && inputFull !== input ? { inputFull } : {}),
          toolUseId: block.id,
          inferenceId,
          parentToolUseId,
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
      // The API's cache diagnostics ride the same event. Only the main agent's
      // count — a subagent runs its own prompt, whose first inference always
      // misses and would drown out the session's signal.
      const miss = ev.message.diagnostics?.cache_miss_reason
      if (!parentToolUseId && miss && typeof miss.type === 'string') {
        usage.cacheMiss = {
          reason: miss.type,
          missedTokens:
            typeof miss.cache_missed_input_tokens === 'number'
              ? miss.cache_missed_input_tokens
              : 0,
        }
      }
    }
  } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    // A subagent's own tool results come back as user events tagged with its
    // spawning call's id, just like its assistant blocks — carry it so they nest
    // under the same chip. The parent call's result (delivered to the main agent)
    // carries no parent id and stays at top level.
    const parentToolUseId =
      typeof ev.parent_tool_use_id === 'string' ? ev.parent_tool_use_id : undefined
    const report = agentReport(ev.tool_use_result)
    for (const block of ev.message.content) {
      if (block.type === 'tool_result') {
        // An Agent call's result is the subagent's final report, wrapped for
        // the model in a hand-back frame. The event also carries it bare, and
        // it becomes the last message of the subagent's trace — the CLI never
        // streams the subagent's own prose.
        if (report !== undefined && !parentToolUseId)
          steps.push({
            kind: 'text',
            text: report,
            parentToolUseId: block.tool_use_id,
            createdAt: at,
          })
        steps.push({
          kind: 'tool_result',
          text: summarizeToolResult(report ?? block.content),
          toolUseId: block.tool_use_id,
          parentToolUseId,
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
      // end. It carries no model of its own — the caller stamps the session's
      // driving model (from the init event) onto it.
      usage = parseUsage(ev.usage as Record<string, unknown>)
      usageFinal = true
    }
    if (typeof ev.total_cost_usd === 'number') {
      let tokens = 0
      if (ev.modelUsage && typeof ev.modelUsage === 'object')
        for (const m of Object.values(ev.modelUsage as Record<string, any>))
          for (const k of [
            'inputTokens',
            'outputTokens',
            'cacheReadInputTokens',
            'cacheCreationInputTokens',
          ])
            if (typeof m?.[k] === 'number') tokens += m[k]
      sessionTotals = { costUsd: ev.total_cost_usd, tokens }
    }
  } else if (ev.type === 'rate_limit_event') {
    // Only a *rejection* actually stopped the turn — a warning (status
    // 'allowed'/…) lets it through and shouldn't arm a scheduled retry. resetsAt
    // is a Unix epoch in seconds; convert to ISO for the rest of the system.
    const info = ev.rate_limit_info
    if (info && typeof info === 'object' && info.status === 'rejected') {
      const secs = info.resetsAt
      if (typeof secs === 'number' && Number.isFinite(secs))
        rateLimitResetsAt = new Date(secs * 1000).toISOString()
    }
  }
  return {
    steps,
    finalText,
    blockedIds,
    usage,
    usageInferenceId,
    usageFinal,
    drivingModel,
    ...(turnStarted ? { turnStarted } : {}),
    ...(apiError ? { apiError } : {}),
    rateLimitResetsAt,
    sessionTotals,
  }
}

export type SessionTotals = { costUsd: number; tokens: number }

// A turn's own cost, from the session totals its result event reported and the
// previous turn's (`prior`: zeros for a fresh session, undefined when resuming a
// session whose previous totals were never recorded). `usage` is the turn's own
// token counts. Returns undefined when the turn's share can't be known.
export function sessionCost(
  now: SessionTotals,
  prior: SessionTotals | undefined,
  usage: Usage,
): number | undefined {
  if (prior) {
    // Totals that went backwards mean the CLI started this session's count
    // over, so everything it reports is this turn's.
    if (now.tokens < prior.tokens || now.costUsd < prior.costUsd) return now.costUsd
    return now.costUsd - prior.costUsd
  }
  // No baseline: the whole total is this turn's only if its tokens are all
  // this turn's own.
  const own = usage.input + usage.output + usage.cacheRead + usage.cacheCreation
  return now.tokens === own ? now.costUsd : undefined
}
