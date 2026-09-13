import { memo } from 'react'
import { CopyButton } from './copyButton'
import { Markdown } from './markdown'
import { useTaskLink } from './taskLinkContext'

// Memoized because it renders a whole message's markdown (a 287KB user message
// in the worst case) and would otherwise re-parse + re-render on every App
// re-render — the 2s poll, streaming updates to *other* messages, and every
// scroll/tab-focus state flip. The task-link resolver it reads is referentially
// stable (see resolveTaskLink's useCallback), so an unchanged `text` skips all
// of that work.
export const MessageText = memo(function MessageText({ text }: { text: string }) {
  const linkTask = useTaskLink()
  if (!text) return null
  return (
    <div className="message-text-wrap">
      <div className="message-text">
        <Markdown text={text} linkTask={linkTask} />
      </div>
      <CopyButton
        text={text}
        label="Copy message text"
        className="message-text-copy"
        size={14}
      />
    </div>
  )
})
