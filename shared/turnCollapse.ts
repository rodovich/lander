import type { Item } from '../src/types'

// The subset of a ride item the collapse reads: whether it carries assistant
// prose (a flow `message`) and how much, whether it's a tool call (the
// separator that splits text sequences), and whether it belongs to a subagent
// rather than the main thread. A ToolItem/MessageItem satisfies this
// structurally, so callers pass a ride's items straight through.
type CollapsibleItem = {
  kind: Item['kind']
  text?: string
  parentId?: string
}

// One agent turn's items split into its main thread and its subagents' items.
// A subagent item (parentId set) belongs to the spawning tool chip, which nests
// it, so it never opens a main-thread group nor feeds the collapse. The links
// go arbitrarily deep: a child's own children are keyed under its id in turn.
export function turnThreads(items: readonly { parentId?: string }[]): {
  mainIdxs: number[]
  childrenByParent: Map<string, number[]>
} {
  const mainIdxs: number[] = []
  const childrenByParent = new Map<string, number[]>()
  items.forEach((it, j) => {
    if (!it.parentId) return void mainIdxs.push(j)
    const sibs = childrenByParent.get(it.parentId)
    if (sibs) sibs.push(j)
    else childrenByParent.set(it.parentId, [j])
  })
  return { mainIdxs, childrenByParent }
}

// Notices sit at the foot of a turn rather than among its steps, so they never
// fold away with them.
export function splitNotices<T extends { kind: string }>(
  items: T[],
): { trace: Exclude<T, { kind: 'notice' }>[]; notices: Extract<T, { kind: 'notice' }>[] } {
  const isNotice = (it: T): it is Extract<T, { kind: 'notice' }> => it.kind === 'notice'
  return {
    trace: items.filter((it): it is Exclude<T, { kind: 'notice' }> => !isNotice(it)),
    notices: items.filter(isNotice),
  }
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

// A note that marks a point in the turn rather than a step of it, so it stands
// in its own group and never folds away.
const isMarker = (kind: string | undefined) => kind === 'context' || kind === 'reprompt'

export function groupInferences(
  items: readonly { groupId?: string; kind?: string }[],
  idxs: readonly number[],
): number[][] {
  const groups: number[][] = []
  let last: string | undefined
  let afterMarker = false
  for (const j of idxs) {
    const it = items[j]
    if (
      groups.length === 0 ||
      isMarker(it.kind) ||
      afterMarker ||
      (it.groupId && last !== undefined && it.groupId !== last)
    )
      groups.push([])
    groups[groups.length - 1].push(j)
    afterMarker = isMarker(it.kind)
    if (it.groupId) last = it.groupId
  }
  return groups
}

// The label a fold shows in place of the stretch it hides, on screen and in
// every text rendering of the conversation.
export function foldSummary(
  items: readonly { kind: string; groupId?: string }[],
  idxs: readonly number[],
): string {
  const steps = groupInferences(items, idxs).length
  const tools = idxs.filter((j) => items[j].kind === 'tool').length
  return (
    `${steps} step${steps === 1 ? '' : 's'}` +
    (tools > 0 ? `, ${tools} tool${tools === 1 ? '' : 's'}` : '') +
    '…'
  )
}

const textLength = (item: CollapsibleItem) =>
  item.kind === 'message' ? (item.text?.length ?? 0) : 0

// Collapse settled assistant traces by their message text, not by provider
// inference groups. Adjacent flow-message items with no tool between them form
// one sequence (Codex emits a message per paragraph, so a single answer is a run
// of them). Keep three sequences — the opening prose before the first tool, the
// longest concatenated sequence, and the last sequence — plus any trailing items
// after the last one, and fold everything in between. Takes one agent turn's
// items and plans over its main thread; subagent items appear in no segment.
// Whether a turn folds at all (the conversation view leaves a running turn
// whole) is the caller's call.
export function planTurnCollapse(
  items: readonly CollapsibleItem[],
): TurnCollapsePlan {
  const indices = turnThreads(items).mainIdxs
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
  for (let pos = 0; pos < n; pos++)
    if (isMarker(items[indices[pos]].kind)) visible[pos] = true

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
