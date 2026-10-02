import { MessageNote } from './messageNote'
import { useTaskLink } from './taskLinkContext'
import { TaskChip } from './timelineNote'
import type { MessageItem } from './types'

// A message another task put in this one's conversation — its launch brief, a
// `lander send`, or the `--notify` wake carrying its closing words — told as
// something that happened to this task, in the voice its other notes use
// ("launched", "wedged"), rather than in the user's: who sent it, with what it
// said behind the disclosure. One wording for all three: the agent is told
// which it was, but the reader needs only who.
export function SentMessageNote({
  item,
  sender,
  slug,
  openOn,
}: {
  item: MessageItem
  // The sending task's id.
  sender: string
  slug: string
  // Opens the message when a search match lands inside it (see TimelineNote).
  openOn?: unknown
}) {
  const current = useTaskLink()(sender, slug)
  return (
    <MessageNote item={item} slug={slug} openOn={openOn}>
      received message from{' '}
      <TaskChip
        id={sender}
        slug={slug}
        title={current?.title || sender}
        status={current?.status}
      />
    </MessageNote>
  )
}
