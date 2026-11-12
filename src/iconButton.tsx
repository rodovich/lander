import type { ComponentProps } from 'react'

export function IconButton({
  label,
  title = label,
  compact,
  className,
  children,
  ...props
}: Omit<ComponentProps<'button'>, 'title'> & {
  label: string
  title?: string | null
  compact?: boolean
}) {
  return (
    <button
      type="button"
      className={
        'icon-button' +
        (compact ? ' compact' : '') +
        (className ? ` ${className}` : '')
      }
      title={title ?? undefined}
      aria-label={label}
      {...props}
    >
      {children}
    </button>
  )
}

export function CloseIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function KebabIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <circle cx="12" cy="5" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="19" r="2" />
    </svg>
  )
}
