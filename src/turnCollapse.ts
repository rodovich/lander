type CollapsibleStep = {
  kind: 'text' | 'tool_use' | 'tool_result'
  text?: string
}

// A run of steps that either stays visible or folds away together. The plan is
// an ordered partition of the trace, so a turn can carry several fold regions.
export type TurnCollapseSegment = {
  hidden: boolean
  indices: number[]
}

export type TurnCollapsePlan = {
  segments: TurnCollapseSegment[]
}

const textLength = (step: CollapsibleStep) =>
  step.kind === 'text' ? (step.text?.length ?? 0) : 0

// Collapse settled assistant traces by their message text, not by provider
// inference groups. Adjacent text steps with no tool between them form one
// sequence (Codex emits a text step per paragraph, so a single answer is a run
// of them). Keep three sequences — the opening prose before the first tool, the
// longest concatenated sequence, and the last sequence — plus any trailing
// steps after the last one, and fold everything in between.
export function planTurnCollapse(
  steps: readonly CollapsibleStep[],
  indices: readonly number[] = steps.map((_, i) => i),
): TurnCollapsePlan {
  const n = indices.length
  const isText = (pos: number) => textLength(steps[indices[pos]]) > 0

  // Maximal runs of consecutive text steps, each a list of positions into
  // `indices`. A tool (or any non-text step) between two texts splits the run.
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
    seq.reduce((sum, pos) => sum + textLength(steps[indices[pos]]), 0)

  const firstToolUsePos = indices.findIndex(
    (j) => steps[j].kind === 'tool_use',
  )

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
  // steps after it — a tail of tools stays with the final message.
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
