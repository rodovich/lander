import { useEffect, useRef, useState } from 'react'
import { isUnread, latestUpdateAt } from './taskMeta'
import { taskKeyOf } from './taskRef'
import type { TaskView, TaskWithProject } from './types'

// The seen-marker machinery, in two hooks because it straddles the list
// shaping: useViewingState owns the raw viewing signals — including the
// sticky-unread set the Unread view's filter consumes — so it must run before
// the list is shaped; useSeenMarker runs the dwell that advances the open
// task's marker, so it needs the selection derived from that shaped list.

// The ambient viewing signals: whether the conversation is scrolled to its
// bottom and this tab is the active one (which together with having a task
// open make the viewer "actively viewing" it), whether DOM focus rests in the
// task list, and the sticky-unread set that keeps read tasks in the Unread
// view while the list holds focus.
export function useViewingState(view: TaskView, tasks: TaskWithProject[]) {
  const [atBottom, setAtBottom] = useState(true)
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
    atBottom,
    setAtBottom,
    tabActive,
    listFocused,
    setListFocused,
    stickyUnread,
  }
}

// The dwell's bookkeeping between steps: the task being actively viewed (null
// when none) and the latest-update baseline snapshotted when viewing began —
// updates at or before it clear only once the dwell elapses; anything past it
// arrived while viewing.
export type SeenDwellState = { taskId: string | null; baseline: string }

export const idleSeenDwell: SeenDwellState = { taskId: null, baseline: '' }

// What the hook's effect should do after a change in the viewing signals:
// cancel any armed dwell ('idle'), (re-)arm the dwell for a newly-viewed task
// ('arm'), mark the task seen at once ('mark'), or nothing ('hold').
export type SeenDwellAction = 'idle' | 'arm' | 'mark' | 'hold'

// One step of the seen-marker rules, pure so the timing policy is testable
// apart from React and the timer plumbing (see useSeenMarker below, which
// executes the actions).
export function stepSeenDwell(
  prev: SeenDwellState,
  input: { taskId: string | null; activelyViewing: boolean; latest: string },
): { state: SeenDwellState; action: SeenDwellAction } {
  // Not actively viewing anything: whatever dwell was pending is a glance that
  // didn't last, so it never marks.
  if (!input.activelyViewing || !input.taskId)
    return { state: idleSeenDwell, action: 'idle' }
  // Just began actively viewing this task: snapshot the baseline and arm the
  // dwell. Anything already present clears only once the dwell elapses.
  if (prev.taskId !== input.taskId)
    return {
      state: { taskId: input.taskId, baseline: input.latest },
      action: 'arm',
    }
  // A new update landed while actively viewing — seen immediately. (Any armed
  // dwell stays; its later markSeen is a no-op against an advanced marker.)
  if (input.latest > prev.baseline)
    return {
      state: { taskId: input.taskId, baseline: input.latest },
      action: 'mark',
    }
  return { state: prev, action: 'hold' }
}

// Move the open task's seen marker per the viewing rules. When the viewer
// starts actively viewing a task (switches to it, focuses the tab, or scrolls
// to the bottom), treat whatever's already there as a baseline and arm a 2s
// dwell that marks it seen — so a glance that doesn't last doesn't clear the
// dot. An update that arrives *while* actively viewing is past that baseline,
// so it's marked seen at once. The decision rules live in stepSeenDwell; this
// hook feeds it the signals and executes its actions.
export function useSeenMarker(opts: {
  current: TaskWithProject | null
  atBottom: boolean
  tabActive: boolean
  markSeen: (id: string) => Promise<void>
}) {
  const { current, atBottom, tabActive, markSeen } = opts

  // The open task's latest completed update, and whether the viewer is actively
  // viewing it (open + tab active + scrolled to the bottom where new content
  // lands).
  const currentLatest = current ? latestUpdateAt(current) : ''
  const activelyViewing = !!current && tabActive && atBottom

  const dwellStateRef = useRef<SeenDwellState>(idleSeenDwell)
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const { state, action } = stepSeenDwell(dwellStateRef.current, {
      taskId: current ? taskKeyOf(current) : null,
      activelyViewing,
      latest: currentLatest,
    })
    dwellStateRef.current = state
    if (action === 'idle' || action === 'arm') {
      if (dwellTimerRef.current) {
        clearTimeout(dwellTimerRef.current)
        dwellTimerRef.current = null
      }
    }
    if (action === 'arm') {
      const id = state.taskId!
      dwellTimerRef.current = setTimeout(() => {
        dwellTimerRef.current = null
        void markSeen(id)
      }, 2000)
    } else if (action === 'mark') {
      void markSeen(state.taskId!)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activelyViewing, currentLatest, current?.id, current?.projectSlug])

  return { activelyViewing }
}
