import { contextLabel, contextSummary, contextDuration } from '../shared/context'
import { TimelineNote } from './timelineNote'
import type { ContextItem } from './types'

export function ContextNote({ item }: { item: ContextItem }) {
  const summary = contextSummary(item)
  const duration = contextDuration(item)
  return (
    <TimelineNote
      at={item.at}
      inTurn
      detail={duration ? { label: 'context change details', body: `Duration: ${duration}` } : undefined}
    >
      {contextLabel(item.action)}{summary && ` · ${summary}`}
    </TimelineNote>
  )
}
