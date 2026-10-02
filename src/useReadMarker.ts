import { useEffect, useRef, useState } from 'react'
import { isUnread } from './readMarker'
import { taskKeyOf } from './taskRef'
import type { TaskView, TaskWithProject } from './types'

// The read-marker machinery, in two hooks because it straddles the list
// shaping: useViewingState owns the raw viewing signals — including the
// sticky-unread set the Unread view's filter consumes — so it must run before
// the list is shaped; useReadMarker runs the dwell that advances the open
// task's marker, so it needs the selection derived from that shaped list.

// How far down the open task's conversation the viewer has read, as the
// conversation pane measures it: the marker that would read every entry whose
// bottom edge is on screen or scrolled past. Tagged with the task it was
// measured on, so a measurement of the task just left can't land on the one
// just opened.
export type ReadUpTo = { key: string; at: string }

// The ambient viewing signals: how far the open conversation is read, whether
// this tab is the active one, whether DOM focus rests in the task list, and the
// sticky-unread set that keeps read tasks in the Unread view while the list
// holds focus.
export function useViewingState(view: TaskView, tasks: TaskWithProject[]) {
  const [readUpTo, setReadUpTo] = useState<ReadUpTo | null>(null)
  const [tabActive, setTabActive] = useState(
    () => !document.hidden && document.hasFocus(),
  )

  // Whether DOM focus currently rests on a row inside the task list. While it
  // does, the Unread view holds onto tasks the viewer reads in place (see the
  // sticky-unread set below) so the list doesn't reshuffle under the keyboard;
  // moving focus to a text field or another window drops that hold.
  const [listFocused, setListFocused] = useState(false)
  // Tasks to keep in the Unread view even though they've been read, because
  // they were read while the list held focus. Accrues every unread task seen
  // during a focused spell and clears when focus leaves the list, at which point
  // the plain unread filter reapplies. Newly-unread tasks need no entry here —
  // they pass the filter on their own — but joining the set keeps them visible
  // if the viewer then reads them without leaving the list.
  const [stickyUnread, setStickyUnread] = useState<Set<string>>(new Set())

  // Track whether this tab is the active one: visible and window-focused.
  useEffect(() => {
    const update = () => setTabActive(!document.hidden && document.hasFocus())
    document.addEventListener('visibilitychange', update)
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
    }
  }, [])

  // Maintain the sticky-unread set. Outside the focused Unread view it stays
  // empty (so the filter is the plain one). While the list holds focus on the
  // Unread view, fold every currently-unread task into it — including ones
  // that just arrived — so that reading a task (which clears its unread mark)
  // leaves it in the list rather than yanking it out from under the cursor.
  useEffect(() => {
    if (view !== 'unread' || !listFocused) {
      setStickyUnread((prev) => (prev.size ? new Set() : prev))
      return
    }
    setStickyUnread((prev) => {
      let next = prev
      for (const t of tasks) {
        const key = taskKeyOf(t)
        if (isUnread(t) && !prev.has(key)) {
          if (next === prev) next = new Set(prev)
          next.add(key)
        }
      }
      return next
    })
  }, [view, listFocused, tasks])

  return {
    readUpTo,
    setReadUpTo,
    tabActive,
    listFocused,
    setListFocused,
    stickyUnread,
  }
}

// How long a stretch of the conversation must stay read — its entries' bottom
// edges on screen or scrolled past, in the active tab — before the marker
// advances over it.
export const READ_DWELL_MS = 3000

// The marker the dwell should advance the open task to, or null for none: the
// pane's measurement, if it's of the open task, the tab is active, and it's
// past the task's current marker. Pure so the policy is testable apart from
// React and the timer plumbing (see useReadMarker below).
export function dwellTarget(input: {
  current: TaskWithProject | null
  readUpTo: ReadUpTo | null
  tabActive: boolean
}): string | null {
  const { current, readUpTo, tabActive } = input
  if (!current || !readUpTo || !tabActive) return null
  if (readUpTo.key !== taskKeyOf(current)) return null
  if (!readUpTo.at || readUpTo.at <= (current.readThrough ?? '')) return null
  return readUpTo.at
}

// Advance the open task's read marker once a measurement has held for the
// dwell. Any change in what's read — the viewer scrolling another entry into
// view, an entry landing on screen, a switch of task or tab — restarts the
// clock, so a viewer scrolling steadily through the conversation marks it when
// they settle rather than entry by entry. The task's own marker isn't a
// trigger: "Mark unread" on the open task sets it back, and that should hold
// until the viewer next reads on, not re-mark itself three seconds later.
export function useReadMarker(opts: {
  current: TaskWithProject | null
  readUpTo: ReadUpTo | null
  tabActive: boolean
  markSeen: (key: string, at: string) => Promise<void>
}) {
  const { current, readUpTo, tabActive, markSeen } = opts
  const currentRef = useRef(current)
  currentRef.current = current

  const key = current ? taskKeyOf(current) : null
  useEffect(() => {
    const at = dwellTarget({ current: currentRef.current, readUpTo, tabActive })
    if (!at || !key) return
    const timer = setTimeout(() => void markSeen(key, at), READ_DWELL_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, readUpTo?.key, readUpTo?.at, tabActive])
}
