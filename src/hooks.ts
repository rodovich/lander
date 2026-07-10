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

// A fixed-anchored popup that hangs under its trigger, flipping *above* it when
// there isn't room below (so it never spills past the window's bottom), with
// outside-click / Escape dismissal and re-anchoring on scroll/resize. Owns the
// open state and returns refs to wire up. The popup is measured after it mounts
// (hidden for one layout tick), so the up/down decision uses its real height.
// Shared by the blocked-permissions summary and the header grant control.
export function useAnchoredPopup() {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
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
      const gap = 6
      const ph = popupRef.current?.offsetHeight ?? 0
      const spaceBelow = window.innerHeight - r.bottom
      const spaceAbove = r.top
      // Flip up only once the height is known (ph > 0) and below can't hold it
      // while above has more room; otherwise hang below.
      const openUp = ph > 0 && spaceBelow < ph + gap && spaceAbove > spaceBelow
      setStyle({
        left: r.left,
        ...(openUp
          ? { bottom: window.innerHeight - r.top + gap }
          : { top: r.bottom + gap }),
      })
    }
    place()
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node))
        setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  // Until the first layout pass sets a real position, keep the mounted popup
  // hidden so its unplaced frame never flashes at the top-left.
  const popupStyle: CSSProperties = style ?? { visibility: 'hidden', top: 0, left: 0 }
  return { open, setOpen, containerRef, triggerRef, popupRef, popupStyle }
}
