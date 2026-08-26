// Where a turn's cross-task actions sit inside its trace.
//
// An action is recorded by the server when the acting task's CLI reaches it,
// which is a different path from the daemon stream that writes the turn's items
// — they share no id, so a note can't be tied to the `lander launch` chip that
// caused it. Anchoring to the next prose instead needs no correlation at all:
// the agent is blocked on the tool result while the CLI runs, so the CLI
// answers before the tool returns, which is before the next inference, which is
// before the prose that inference writes. "This happened before that paragraph"
// is a fact about the order of operations, not a guess about timing.
//
// It also makes the fold a non-issue. The anchor is a prose section the
// collapse plan KEEPS, so a note whose cause is inside a folded stretch surfaces
// below that stretch's summary rather than hiding behind it — with no second
// render path, and no row that moves when the reader expands a segment.

import type { TurnCollapsePlan } from './turnCollapse'
import type { TaskActionItem } from './types'

// The subset of a ride item this reads: whether it carries assistant prose.
type AnchorItem = { kind: string; at: string; text?: string; parentId?: string }

export type TurnActionAnchors = {
  // Actions to render immediately before the item at this index.
  before: Map<number, TaskActionItem[]>
  // Actions with no prose left to precede — the turn's last word on other
  // tasks, rendered after its trace.
  tail: TaskActionItem[]
}

// The main-thread items that open a prose section: a flow message with text
// whose previous main-thread item isn't one. The same runs planTurnCollapse
// calls sequences — a provider that emits a message per paragraph (Codex) has
// one section per answer, not one per paragraph.
function proseStarts(
  items: readonly AnchorItem[],
  mainIdxs: readonly number[],
): number[] {
  const isProse = (j: number) =>
    items[j].kind === 'message' && (items[j].text?.length ?? 0) > 0
  return mainIdxs.filter(
    (j, pos) => isProse(j) && !(pos > 0 && isProse(mainIdxs[pos - 1])),
  )
}

// Place each action before the first prose section that follows it — skipping
// any the collapse plan hides, so every note lands where it can be read without
// opening a fold. An action later than the last such section (or in a turn with
// no prose at all) falls to the tail, which is where these have always rendered.
export function planTurnActions(
  items: readonly AnchorItem[],
  mainIdxs: readonly number[],
  actions: readonly TaskActionItem[],
  plan: TurnCollapsePlan,
): TurnActionAnchors {
  const before = new Map<number, TaskActionItem[]>()
  const tail: TaskActionItem[] = []
  if (!actions.length) return { before, tail }

  const hidden = new Set(
    plan.segments.flatMap((seg) => (seg.hidden ? seg.indices : [])),
  )
  const anchors = proseStarts(items, mainIdxs).filter((j) => !hidden.has(j))

  for (const action of actions) {
    // Timestamps compare as strings: both are ISO-8601 from the same clock.
    const j = anchors.find((k) => items[k].at > action.at)
    if (j === undefined) {
      tail.push(action)
      continue
    }
    const at = before.get(j)
    if (at) at.push(action)
    else before.set(j, [action])
  }
  return { before, tail }
}
