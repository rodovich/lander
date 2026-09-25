import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, Dispatch, SetStateAction } from 'react'
import { dataTransferHasFiles } from './fileDrop'

// useState that mirrors itself to localStorage under `key`, so the value
// survives a dev hot reload, a full page reload, or accidental navigation —
// without which an in-progress draft (a half-typed task or reply) is lost the
// moment React Fast Refresh remounts the component. The stored value is JSON;
// every store access tolerates an unavailable or corrupt store (private mode,
// quota) by falling back to `initial`. Drives only deliberately-kept *draft*
// state — ephemeral UI (open menus, popups, focus) is left to reset.
export function usePersistentState<T>(
  key: string,
  initial: T,
  store: Storage = localStorage,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = store.getItem(key)
      return raw != null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      store.setItem(key, JSON.stringify(value))
    } catch {
      // storage unavailable — the value simply won't persist
    }
  }, [key, value])
  return [value, setValue]
}

// Like usePersistentState but backed by sessionStorage, which is scoped to a
// single tab: the value survives a hot reload or refresh within that tab, yet
// two tabs keep independent values (and each is dropped when its tab closes).
// Used for view state a user reasonably expects to differ per tab — the list
// filters and the per-tab drafts they're composing — rather than a global
// preference, which stays on localStorage so it holds everywhere at once.
export function useSessionState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  return usePersistentState(key, initial, sessionStorage)
}

// Make an element a file-only drop target without swallowing ordinary dragged
// text. The depth counter keeps the highlight steady while a drag crosses child
// elements (the paperclip's SVG, for example), which fire their own enter/leave
// events. Dropped files feed the same File[] state as the native file picker.
export function useFileDrop<T extends HTMLElement>(
  onAdd: (files: File[]) => void,
  disabled = false,
) {
  const [active, setActive] = useState(false)
  const depth = useRef(0)

  useEffect(() => {
    if (disabled) {
      depth.current = 0
      setActive(false)
    }
  }, [disabled])

  return {
    active,
    handlers: {
      onDragEnter(e: React.DragEvent<T>) {
        if (disabled || !dataTransferHasFiles(e.dataTransfer)) return
        e.preventDefault()
        depth.current += 1
        setActive(true)
      },
      onDragOver(e: React.DragEvent<T>) {
        if (disabled || !dataTransferHasFiles(e.dataTransfer)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave(e: React.DragEvent<T>) {
        if (disabled || depth.current === 0) return
        e.preventDefault()
        depth.current -= 1
        if (depth.current === 0) setActive(false)
      },
      onDrop(e: React.DragEvent<T>) {
        const files = Array.from(e.dataTransfer.files)
        if (disabled || files.length === 0) return
        e.preventDefault()
        depth.current = 0
        setActive(false)
        onAdd(files)
      },
    },
  }
}

// The closest a fixed-anchored popup may come to the window's edge.
const VIEWPORT_MARGIN = 8

// Where a `position: fixed` popup goes, relative to its trigger's live viewport
// rect, so it stays inside the window: it hangs under the trigger, flipping
// *above* it when there isn't room below, and left-aligns with it, flipping to
// right-align when there isn't room to the right — then is clamped into the
// window if even that overflows. The popup is measured after it mounts (hidden
// for one layout tick), so both decisions use its real size, and it re-anchors
// on scroll/resize. Open state belongs to the caller; useAnchoredPopup adds it
// with dismissal for a standalone popup, while a popup whose open state lives
// elsewhere (a rule row's scope menu) uses this directly. `gap` is the distance
// it stands off its trigger.
export function useAnchoredPosition(open: boolean, gap: number) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popupRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setStyle(null)
      return
    }
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect()
      if (!r) return
      const ph = popupRef.current?.offsetHeight ?? 0
      const pw = popupRef.current?.offsetWidth ?? 0
      const spaceBelow = window.innerHeight - r.bottom
      const spaceAbove = r.top
      // Flip up only once the height is known (ph > 0) and below can't hold it
      // while above has more room; otherwise hang below.
      const openUp = ph > 0 && spaceBelow < ph + gap && spaceAbove > spaceBelow
      const maxLeft = window.innerWidth - VIEWPORT_MARGIN - pw
      const left = r.left <= maxLeft ? r.left : r.right - pw
      setStyle({
        left: Math.max(VIEWPORT_MARGIN, Math.min(left, maxLeft)),
        ...(openUp
          ? { bottom: window.innerHeight - r.top + gap }
          : { top: r.bottom + gap }),
      })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, gap])

  // Until the first layout pass sets a real position, keep the mounted popup
  // hidden so its unplaced frame never flashes at the top-left.
  const popupStyle: CSSProperties = style ?? { visibility: 'hidden', top: 0, left: 0 }
  return { triggerRef, popupRef, popupStyle }
}

// A fixed-anchored popup (placed by useAnchoredPosition) that owns its open
// state and closes on an outside click or Escape. Shared by the actions menus,
// the blocked-permissions summary, and the header grant control.
export function useAnchoredPopup({ gap = 6 }: { gap?: number } = {}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const { triggerRef, popupRef, popupStyle } = useAnchoredPosition(open, gap)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node))
        setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return { open, setOpen, containerRef, triggerRef, popupRef, popupStyle }
}
