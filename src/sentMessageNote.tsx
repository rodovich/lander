import { MessageAttachments } from './attachments'
import { MessageText } from './messageText'
import { useTaskLink } from './taskLinkContext'
import { TaskChip, TimelineNote } from './timelineNote'
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
  const files = item.attachments ?? []
  const hasBody = !!item.text || files.length > 0
  return (
    <TimelineNote
      at={item.at}
      variant={item.queued ? 'message-queued' : undefined}
      detail={
        hasBody
          ? {
              label: 'message',
              openOn,
              body: (
                <>
                  <MessageText text={item.text} itemId={item.id} />
                  {files.length > 0 && (
                    <MessageAttachments attachments={files} slug={slug} />
                  )}
                </>
              ),
            }
          : undefined
      }
    >
      received message from{' '}
      <TaskChip
        id={sender}
        slug={slug}
        title={current?.title || sender}
        status={current?.status}
      />
    </TimelineNote>
  )
}
