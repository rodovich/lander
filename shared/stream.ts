import type { ContextUpdate } from './context'

export type Step = {
  // `notice`: a flow's own note about the turn, carried in `text`.
  // `reprompt`: the flow prompted its agent again within the turn; `text` is
  // what it sent.
  kind: 'text' | 'tool_use' | 'tool_result' | 'context' | 'notice' | 'reprompt'
  context?: ContextUpdate
  text?: string
  tool?: string
  input?: string
  // tool_use only: the identifying input field untruncated and newline-preserving
  // — the exact text `input` collapses to one line — so the expanded chip can show
  // a multi-line command or a long argument as written. Set only when it carries
  // more than the one-line `input` summary (a multi-line or truncated input),
  // omitted for short single-line inputs to keep task files lean. Capped like
  // `edits` at 4k. Absent on steps recorded before this field existed.
  inputFull?: string
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
  // The stream's top-level `parent_tool_use_id`: when this block was produced by
  // a subagent (the Agent/Explore tools spawn one), the id of the parent tool_use
  // that spawned it — otherwise absent. It's set on the subagent's own text,
  // tool_use, and tool_result blocks alike (the whole nested trace), and points at
  // the spawning chip's `toolUseId`, so the UI can fold a subagent's activity in
  // under that chip instead of interleaving it with the main agent's. Nesting goes
  // arbitrarily deep — a sub-subagent's blocks carry its spawner's id — so the
  // parent→child links form the tree. Absent on every main-agent block.
  parentToolUseId?: string
  // tool_use only: the call rendered as a settings.json permission string
  // (e.g. `Bash(npm run build)`), used to seed the "allow" popup.
  rule?: string
  // tool_use only, for the file-writing tools (Edit/Write/MultiEdit): the change
  // as before/after hunks, so the UI can reveal a diff under the chip. One hunk
  // per edit (MultiEdit has several); Write has a single hunk with empty `old`.
  // Absent for every other tool.
  edits?: { old: string; new: string }[]
  // tool_result fields. `isError` is the result's own error flag — set whenever
  // the call errored, whether it was refused before running or ran and failed.
  // `blocked` narrows that to a permission-gate refusal: set during a turn's
  // terminal result event from its authoritative permission_denials list, not
  // inferred from the result text. (That list covers only the interactive
  // permission gate — a Bash static-analysis or sandbox block surfaces as
  // `isError` without `blocked`.) The UI reads a `blocked` call as "blocked" and
  // offers a grant; an `isError`-only call as "failed"; neither as a clean run.
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
// reduceStreamLine's `drivingModel`. `costUsd` is the turn's dollar cost across
// every model it touched; it is derived only once the turn's final event lands,
// so it's absent until then. The UI shows the most recent turn's counts in the
// corner, updating as they stream, and can sum them across the task.
export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  model?: string
  costUsd?: number
  // The provider's running cost for the whole session as of this turn, when the
  // flow derived `costUsd` from one. Claude's `total_cost_usd` carries every
  // earlier turn of a resumed session (CLI 2.1.278+), so a turn's own cost is
  // the difference from the previous turn's total.
  sessionCostUsd?: number
  // Why the turn's prompt cache missed, when the API reported one (Claude's
  // assistant events carry `message.diagnostics.cache_miss_reason`): the reason
  // type (e.g. `system_changed`, `tools_changed`, `previous_message_not_found`)
  // and the tokens that had to be re-processed instead of read from cache. Taken
  // from the turn's first main-agent inference that reports one — the
  // resume-boundary miss, the interesting one — and kept through the result
  // event's authoritative replacement (see the run manager). Subagent inferences
  // are ignored: they run separate prompts whose first inference always misses.
  // Absent when the turn hit cache cleanly, and for providers that don't report
  // it (Codex).
  cacheMiss?: CacheMiss
}

export type CacheMiss = {
  reason: string
  missedTokens: number
}
