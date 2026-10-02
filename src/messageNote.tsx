import type { ReactNode } from 'react'
import { MessageAttachments } from './attachments'
import { MessageText } from './messageText'
import { TimelineNote } from './timelineNote'
import type { MessageItem } from './types'

// A timeline note that carries a message behind its disclosure: the sentence
// saying how the message arrived, with its words and files revealed beneath.
// Dimmed while the message is still queued, as a queued bubble is. Shared by
// every message that reaches the reader as an account of what happened to the
// task rather than as someone speaking in it.
export function MessageNote({
  item,
  at = item.at,
  slug,
  openOn,
  children,
}: {
  item: MessageItem
  // When the note happened, if not when the message was written.
  at?: string
  slug: string
  // Opens the message when a search match lands inside it (see TimelineNote).
  openOn?: unknown
  // The sentence.
  children: ReactNode
}) {
  const files = item.attachments ?? []
  const hasBody = !!item.text || files.length > 0
  return (
    <TimelineNote
      at={at}
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
      {children}
    </TimelineNote>
  )
}
