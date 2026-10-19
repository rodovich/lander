import { REPROMPT_LABEL } from '../shared/conversationText'
import { TimelineNote } from './timelineNote'
import type { RepromptItem } from './types'

export function RepromptNote({ item }: { item: RepromptItem }) {
  return (
    <TimelineNote at={item.at} inTurn detail={{ label: 'message', body: item.text }}>
      {REPROMPT_LABEL}
    </TimelineNote>
  )
}
