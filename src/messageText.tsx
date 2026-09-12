import { memo } from 'react'
import { CopyButton } from './copyButton'
import { Markdown } from './markdown'
import type { TaskLinkResolver } from './markdown'

// Memoized because it renders a whole message's markdown (a 287KB user message
// in the worst case) and would otherwise re-parse + re-render on every App
// re-render — the 2s poll, streaming updates to *other* messages, and every
// scroll/tab-focus state flip. With `linkTask` kept referentially stable (see
// resolveTaskLink's useCallback), an unchanged `text` now skips all of that work.
export const MessageText = memo(function MessageText({
  text,
  linkTask,
}: {
  text: string
  linkTask: TaskLinkResolver
}) {
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
