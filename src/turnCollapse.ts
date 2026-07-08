type CollapsibleStep = {
  kind: 'text' | 'tool_use' | 'tool_result'
  text?: string
}

export type TurnCollapsePlan = {
  visibleBefore: number[]
  hidden: number[]
  visibleAfter: number[]
}

const textLength = (step: CollapsibleStep) =>
  step.kind === 'text' ? (step.text?.length ?? 0) : 0

// Collapse settled assistant traces by assistant messages, not by provider
// inference groups: optionally keep the opening prose, hide the middle, then
// keep the longest message and every step after it.
export function planTurnCollapse(
  steps: readonly CollapsibleStep[],
  indices: readonly number[] = steps.map((_, i) => i),
): TurnCollapsePlan {
  const full = [...indices]
  const textPositions = indices
    .map((j, pos) => ({ pos, length: textLength(steps[j]) }))
    .filter(({ length }) => length > 0)

  if (textPositions.length === 0) {
    return { visibleBefore: [], hidden: [], visibleAfter: full }
  }

  const firstTextPos = textPositions[0].pos
  const longestTextPos = textPositions.reduce((best, current) =>
    current.length > best.length ? current : best,
  ).pos
  const firstToolUsePos = indices.findIndex((j) => steps[j].kind === 'tool_use')
  const keepOpeningText =
    firstToolUsePos === -1 || firstTextPos < firstToolUsePos

  const hiddenStart =
    keepOpeningText && firstTextPos < longestTextPos ? firstTextPos + 1 : 0
  const hidden = indices.slice(hiddenStart, longestTextPos)

  if (hidden.length === 0) {
    return { visibleBefore: [], hidden: [], visibleAfter: full }
  }

  return {
    visibleBefore: keepOpeningText ? indices.slice(0, firstTextPos + 1) : [],
    hidden,
    visibleAfter: indices.slice(longestTextPos),
  }
}
