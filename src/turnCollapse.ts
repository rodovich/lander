// The subset of a ride item the collapse reads: whether it carries assistant
// prose (a flow `message`) and how much, and whether it's a tool call (the
// separator that splits text sequences). A ToolItem/MessageItem satisfies this
// structurally, so callers pass a ride's items straight through.
type CollapsibleItem = {
  kind: 'message' | 'tool' | 'event' | 'ask'
  text?: string
}

// A run of items that either stays visible or folds away together. The plan is
// an ordered partition of the trace, so a turn can carry several fold regions.
export type TurnCollapseSegment = {
  hidden: boolean
  indices: number[]
}

export type TurnCollapsePlan = {
  segments: TurnCollapseSegment[]
}

const textLength = (item: CollapsibleItem) =>
  item.kind === 'message' ? (item.text?.length ?? 0) : 0

// Collapse settled assistant traces by their message text, not by provider
// inference groups. Adjacent flow-message items with no tool between them form
// one sequence (Codex emits a message per paragraph, so a single answer is a run
// of them). Keep three sequences — the opening prose before the first tool, the
// longest concatenated sequence, and the last sequence — plus any trailing items
// after the last one, and fold everything in between. Operates over a ride's
// main-thread items; the caller passes the item array and the `indices` of the
// main thread (subagent-nested items excluded).
export function planTurnCollapse(
  items: readonly CollapsibleItem[],
  indices: readonly number[] = items.map((_, i) => i),
): TurnCollapsePlan {
  const n = indices.length
  const isText = (pos: number) => textLength(items[indices[pos]]) > 0

  // Maximal runs of consecutive text items, each a list of positions into
  // `indices`. A tool (or any non-text item) between two texts splits the run.
  const sequences: number[][] = []
  for (let pos = 0; pos < n; pos++) {
    if (!isText(pos)) continue
    if (pos > 0 && isText(pos - 1)) sequences[sequences.length - 1].push(pos)
    else sequences.push([pos])
  }

  const all: TurnCollapsePlan = {
    segments: [{ hidden: false, indices: [...indices] }],
  }
  if (sequences.length === 0) return all

  const seqLength = (seq: number[]) =>
    seq.reduce((sum, pos) => sum + textLength(items[indices[pos]]), 0)

  const firstToolUsePos = indices.findIndex((j) => items[j].kind === 'tool')

  // Keep the opening sequence only when it precedes the first tool call.
  const openingSeq =
    firstToolUsePos === -1 || sequences[0][0] < firstToolUsePos
      ? sequences[0]
      : null
  const longestSeq = sequences.reduce((best, seq) =>
    seqLength(seq) > seqLength(best) ? seq : best,
  )
  const lastSeq = sequences[sequences.length - 1]

  // Mark the kept sequences visible, plus the last sequence and any trailing
  // items after it — a tail of tools stays with the final message.
  const visible = new Array<boolean>(n).fill(false)
  const mark = (seq: number[]) => seq.forEach((pos) => (visible[pos] = true))
  if (openingSeq) mark(openingSeq)
  mark(longestSeq)
  for (let pos = lastSeq[0]; pos < n; pos++) visible[pos] = true

  // Coalesce contiguous visible / hidden positions into segments.
  const segments: TurnCollapseSegment[] = []
  for (let pos = 0; pos < n; pos++) {
    const hidden = !visible[pos]
    const tail = segments[segments.length - 1]
    if (!tail || tail.hidden !== hidden) segments.push({ hidden, indices: [] })
    segments[segments.length - 1].indices.push(indices[pos])
  }

  return segments.some((seg) => seg.hidden) ? { segments } : all
}
