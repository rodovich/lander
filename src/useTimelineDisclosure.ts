import { useCallback, useEffect, useMemo, useState } from 'react'

// What the reader has opened on the open task's timeline: tool chips whose
// detail is revealed, and settled turns whose folded middle is expanded. Read by
// the timeline to draw them and by the conversation copy to write what's showing.
export type TimelineDisclosure = {
  // Tool item ids whose detail (full input, a diff, output, a subagent trace) is
  // revealed. Details start closed and several can be open at once.
  openDetails: Set<string>
  // Fold keys, `${rideId}:${segmentIndex}`, the reader has expanded.
  expandedTurns: Set<string>
  // Toggle one chip's detail, or — when option/shift was held — every detail in
  // its ride together, driving them all to this chip's new (opposite) state.
  toggleDetail: (key: string, rideKeys: string[]) => void
  toggleTurn: (segKey: string) => void
}

// Owns a task's TimelineDisclosure, cleared when the task switches so neither
// set bleeds across tasks and each opens with its history folded down again.
// The object's identity changes only when one of the sets does, so the memoized
// turns it reaches hold still otherwise.
export function useTimelineDisclosure(
  task: { id: string; projectSlug: string } | null,
): TimelineDisclosure {
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set())
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set())

  useEffect(() => {
    setOpenDetails(new Set())
    setExpandedTurns(new Set())
  }, [task?.id, task?.projectSlug])

  const toggleDetail = useCallback((key: string, rideKeys: string[]) => {
    setOpenDetails((prev) => {
      const next = new Set(prev)
      const willOpen = !prev.has(key)
      for (const k of rideKeys) {
        if (willOpen) next.add(k)
        else next.delete(k)
      }
      return next
    })
  }, [])

  const toggleTurn = useCallback((segKey: string) => {
    setExpandedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(segKey)) next.delete(segKey)
      else next.add(segKey)
      return next
    })
  }, [])

  return useMemo(
    () => ({ openDetails, expandedTurns, toggleDetail, toggleTurn }),
    [openDetails, expandedTurns, toggleDetail, toggleTurn],
  )
}
