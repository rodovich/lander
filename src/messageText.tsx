import { memo, useState } from 'react'
import { Markdown } from './markdown'
import type { TaskLinkResolver } from './markdown'

// A clipboard button shown beside a rendered text block. Briefly flips to a
// checkmark after a successful copy so the click registers.
function CopyButton({
  text,
  className = 'message-text-copy',
  title = 'Copy message text',
}: {
  text: string
  className?: string
  title?: string
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied (e.g. insecure context); ignore.
    }
  }
  return (
    <button
      type="button"
      className={className}
      onClick={copy}
      title={title}
      aria-label={copied ? 'Copied' : title}
    >
      {copied ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M20 6 9 17l-5-5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect
            x="9"
            y="9"
            width="11"
            height="11"
            rx="2"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M5 15V5a2 2 0 0 1 2-2h10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  )
}

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
      <CopyButton text={text} />
    </div>
  )
})
