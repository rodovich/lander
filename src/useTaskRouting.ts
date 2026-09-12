import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { taskHref, taskKey, taskKeyOf, taskRefFromPath, type TaskRef } from './taskRef'
import type { TaskLink, TaskView, TaskWithProject } from './types'

// Which task is open, and the URL that says so. The address is /<project>/<id>:
// a pick pushes it, back/forward follows it, a click on any task link routes
// in-process instead of reloading, and the effective selection is mirrored back
// into the address bar. A route can name a task whose project or archive pool
// isn't loaded yet; it is held pending — the URL left alone — until the global
// task index can say where that task lives.
export function useTaskRouting({
  initialRef,
  tasks,
  orderedTasks,
  taskLinks,
  taskLinksLoaded,
  hasLoadedRef,
  setShown,
  setView,
  onNavigate,
}: {
  // The task the page was opened on, if its URL named one.
  initialRef: TaskRef | null
  // The loaded tasks, and the order the list shows them in — the fallback
  // selection is the first of these.
  tasks: TaskWithProject[]
  orderedTasks: TaskWithProject[]
  // The compact index of every task in every project, which resolves a route
  // to a task this client hasn't loaded.
  taskLinks: TaskLink[]
  taskLinksLoaded: boolean
  hasLoadedRef: { readonly current: boolean }
  // Routing to a task in another project or pool widens the list to show it.
  setShown: Dispatch<SetStateAction<string[]>>
  setView: Dispatch<SetStateAction<TaskView>>
  // Called on every navigation, for whatever the pane was showing instead of a
  // task (the hooks panel). Must be stable.
  onNavigate: () => void
}) {
  const initialKey = initialRef ? taskKey(initialRef.projectSlug, initialRef.id) : null
  // The user's explicit task pick. The effective selection (`selected`, below)
  // falls back to the first visible task when this one is filtered away.
  const [selectedTaskKey, setSelectedTaskKey] = useState<string | null>(initialKey)
  const [pendingRouteKey, setPendingRouteKey] = useState<string | null>(initialKey)

  const taskLinkByKey = useMemo(
    () => new Map(taskLinks.map((link) => [taskKey(link.projectSlug, link.id), link])),
    [taskLinks],
  )

  // The effective selection: the user's pick if it's still visible, otherwise
  // the first task in the list (e.g. after filtering hides the prior pick).
  const selected =
    selectedTaskKey &&
    (pendingRouteKey || tasks.some((t) => taskKeyOf(t) === selectedTaskKey))
      ? selectedTaskKey
      : orderedTasks[0]
        ? taskKeyOf(orderedTasks[0])
        : null
  const current = tasks.find((t) => taskKeyOf(t) === selected) ?? null

  // Stable, so the memoized panes receiving it don't re-render on unrelated
  // App state.
  const selectTask = useCallback(
    (id: string, projectSlug: string) => {
      setSelectedTaskKey(taskKey(projectSlug, id))
      setPendingRouteKey(null)
      onNavigate()
      window.history.pushState(null, '', taskHref(projectSlug, id))
    },
    [onNavigate],
  )

  const routeToTask = useCallback(
    (ref: TaskRef, push: boolean) => {
      const key = taskKey(ref.projectSlug, ref.id)
      const link = taskLinkByKey.get(key)
      setSelectedTaskKey(key)
      setPendingRouteKey(key)
      onNavigate()
      setShown((prev) =>
        prev.includes(ref.projectSlug) ? prev : [ref.projectSlug],
      )
      if (link)
        setView((prev) =>
          link.archived ? 'archived' : prev === 'archived' ? 'inbox' : prev,
        )
      if (push)
        window.history.pushState(null, '', taskHref(ref.projectSlug, ref.id))
    },
    [onNavigate, setShown, setView, taskLinkByKey],
  )

  // A route intent holds the URL steady while its project/pool reloads. Once
  // the compact global index resolves it, select the right project and active
  // vs archived pool; an unknown route falls back only after that index loaded.
  useEffect(() => {
    if (!pendingRouteKey) return
    if (tasks.some((task) => taskKeyOf(task) === pendingRouteKey)) {
      setPendingRouteKey(null)
      return
    }
    const link = taskLinkByKey.get(pendingRouteKey)
    if (!link) {
      if (taskLinksLoaded) {
        setPendingRouteKey(null)
        setSelectedTaskKey((prev) => (prev === pendingRouteKey ? null : prev))
      }
      return
    }
    setShown((prev) =>
      prev.includes(link.projectSlug) ? prev : [link.projectSlug],
    )
    setView((prev) =>
      link.archived ? 'archived' : prev === 'archived' ? 'inbox' : prev,
    )
  }, [pendingRouteKey, setShown, setView, taskLinkByKey, taskLinksLoaded, tasks])

  // Task links are ordinary anchors for copy/open-in-new-tab semantics. Plain
  // clicks stay in-process so browser history, drafts, and file attachments all
  // survive a cross-project hop.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest<HTMLAnchorElement>('a[href]')
      if (!anchor || (anchor.target && anchor.target !== '_self')) return
      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return
      const ref = taskRefFromPath(url.pathname)
      if (!ref || !taskLinkByKey.has(taskKey(ref.projectSlug, ref.id))) return
      event.preventDefault()
      routeToTask(ref, true)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [routeToTask, taskLinkByKey])

  // Keep the selection in sync when navigating with the browser back/forward
  // buttons.
  useEffect(() => {
    const onPop = () => {
      const ref = taskRefFromPath()
      if (ref) routeToTask(ref, false)
      else {
        setSelectedTaskKey(null)
        setPendingRouteKey(null)
      }
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [routeToTask])

  // Mirror the effective selection into the URL as /<project>/<id>. Held
  // off until tasks have loaded so a deep-linked task isn't clobbered before
  // its project's tasks arrive. replaceState (not push) corrects the URL in
  // place without adding spurious history entries.
  useEffect(() => {
    if (!hasLoadedRef.current || pendingRouteKey) return
    const desired = current ? taskHref(current.projectSlug, current.id) : '/'
    if (window.location.pathname !== desired) {
      window.history.replaceState(null, '', desired)
    }
  }, [current, hasLoadedRef, pendingRouteKey])

  return { selected, current, selectTask }
}
