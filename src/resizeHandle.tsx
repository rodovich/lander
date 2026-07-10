import type { Dispatch, SetStateAction } from 'react'

// A draggable divider that sits just above the panel it resizes (the reply
// composer, the new-task form). Dragging up grows that panel and shrinks the
// scrollable region above it; dragging down does the reverse. The panel's
// height is clamped to [min, container − reserveTop] so neither the panel nor
// the region above it can be dragged shut. It measures its own flex container
// (its parent) at drag start, so it needs no ref threaded down.
export function ResizeHandle({
  height,
  setHeight,
  min,
  reserveTop,
  label,
}: {
  height: number
  setHeight: Dispatch<SetStateAction<number>>
  min: number
  reserveTop: number
  label: string
}) {
  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    const containerH =
      el.parentElement?.getBoundingClientRect().height ?? Infinity
    const max = Math.max(min, containerH - reserveTop)
    const startY = e.clientY
    const startH = height
    function onMove(ev: PointerEvent) {
      // Dragging up (clientY decreases) grows the panel below the handle.
      const next = startH + (startY - ev.clientY)
      setHeight(Math.round(Math.max(min, Math.min(max, next))))
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      el.classList.remove('resize-handle-active')
      document.body.classList.remove('resizing-row')
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    el.classList.add('resize-handle-active')
    document.body.classList.add('resizing-row')
  }

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      onPointerDown={onPointerDown}
    />
  )
}
