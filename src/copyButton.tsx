import { useState } from 'react'
import { IconButton } from './iconButton'

// The checkmark every copy button flips to for a moment after a successful
// copy, so the click registers.
const CHECK_ICON = (
  <path
    d="M20 6 9 17l-5-5"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  />
)

// A sheet of paper lifting off another: the default face of a copy button.
export const CLIPBOARD_ICON = (
  <>
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
  </>
)

// An icon button that writes text to the clipboard and briefly becomes a
// checkmark. `text` may be a callback, for a copy that builds a whole document
// — work worth doing on the click rather than on every render of the button.
export function CopyButton({
  text,
  label,
  className,
  compact,
  icon = CLIPBOARD_ICON,
  size = 15,
}: {
  text: string | (() => string)
  // Both the tooltip and the accessible name, which becomes "Copied" while the
  // checkmark is showing.
  label: string
  className?: string
  compact?: boolean
  icon?: React.ReactNode
  size?: number
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(
        typeof text === 'function' ? text() : text,
      )
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied (e.g. insecure context); ignore.
    }
  }
  return (
    <IconButton
      label={copied ? 'Copied' : label}
      title={label}
      compact={compact}
      className={className}
      onClick={copy}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
        {copied ? CHECK_ICON : icon}
      </svg>
    </IconButton>
  )
}
