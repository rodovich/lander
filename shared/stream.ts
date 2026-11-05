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
  // When a subagent produced this step, the `toolUseId` of the parent tool call
  // that spawned it (mapped to `Item.parentId` so the timeline nests the
  // subagent's trace under the spawning tool item).
  parentToolUseId?: string
  // tool_use only: the call formatted in the flow's permission-rule syntax,
  // used to seed a grant in the UI.
  rule?: string
  // tool_use only: file-modification hunks revealed as a diff under the chip
  // (`old` is empty for a full-file write).
  edits?: { old: string; new: string }[]
  isError?: boolean
  createdAt: string
}

// Token usage for a turn. `input` (uncached), `cacheCreation` (newly cached),
// and `cacheRead` (re-read from cache) partition the prompt tokens processed
// across the turn's inferences, so their sum is the total prompt size.
export type Usage = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  model?: string
  // The driving model's reasoning effort, from flows that report one.
  effort?: string
  costUsd?: number
  // The provider's running cost for the whole session as of this turn, when the
  // flow derived `costUsd` from one. Claude's `total_cost_usd` carries every
  // earlier turn of a resumed session (CLI 2.1.278+), so a turn's own cost is
  // the difference from the previous turn's total.
  sessionCostUsd?: number
  // Why the turn's prompt cache missed on its resume boundary, when the
  // provider reports cache-miss diagnostics (e.g. Claude's
  // `message.diagnostics.cache_miss_reason`). Subagent inferences are excluded
  // because their separate prompts always miss on their first inference.
  cacheMiss?: CacheMiss
}

export type CacheMiss = {
  reason: string
  missedTokens: number
}
