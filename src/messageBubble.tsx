import { formatTimestamp } from './format'

// A bubble on the conversation timeline: who spoke, when, and what they said.
// Every voice wears it — the user, an assistant turn, a hook's report, the
// platform's own account of something — so a row that outlives the controls in
// it (an answered ask, a finished turn) still reads as the record of a moment
// rather than a sentence floating loose. `variant` is the second class that
// tints it (`message-user`, `message-assistant`, `message-platform`, …).
export function MessageBubble({
  role,
  at,
  variant,
  children,
}: {
  // How the speaker is named in the head: "user", "assistant", "hook cleanup".
  role: string
  at: string
  variant?: string
  children: React.ReactNode
}) {
  return (
    <div className={'message' + (variant ? ` ${variant}` : '')}>
      <div className="message-head">
        <span className="message-role">{role}</span>
        <span className="message-time">{formatTimestamp(at)}</span>
      </div>
      {children}
    </div>
  )
}
