import { useEffect, useId, useRef, type ReactNode } from 'react'

const FOCUSABLE =
  ':is(a[href], button, input, select, textarea, audio[controls], video[controls], iframe, [tabindex]):not(:disabled):not([tabindex="-1"])'

export function Modal({
  title,
  headExtra,
  closeLabel,
  onClose,
  children,
}: {
  title: string
  // Beside the title, such as a gallery's position.
  headExtra?: ReactNode
  closeLabel: string
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    ref.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const focusable = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (!first || !last) return
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === ref.current)
        )
          last.focus()
        else if (!event.shiftKey && document.activeElement === last) first.focus()
        else return
      } else if (event.key === 'Escape') onClose()
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="modal-head">
          <div className="modal-heading">
            <span id={titleId} className="modal-title" title={title}>
              {title}
            </span>
            {headExtra}
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
