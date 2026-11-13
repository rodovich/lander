import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { loadAttachment, loadTask } from './api'
import { GalleryModal, OpenGalleryContext, type Gallery } from './attachments'
import { Composer } from './composer'
import { Conversation } from './conversation'
import { ErrorBoundary } from './errorBoundary'
import { DEFAULT_VIEW } from './format'
import { startPoll } from './poll'
import { MonotonicRequestGate } from './requestOrder'
import { isUnread } from './readMarker'
import { NO_GRANTS } from './taskMeta'
import { taskHref, taskKeyOf, type TaskRef } from './taskRef'
import type { Attachment, TaskLink, TaskWithProject } from './types'
import { useFencedTasks } from './useFencedTasks'
import { useReadMarker, useViewingState } from './useReadMarker'
import { useReplyDrafts } from './useReplyDrafts'
import { useTaskActions } from './useTaskActions'
import { POLL_GAP_MS } from './useTaskData'
import { useTimelineDisclosure } from './useTimelineDisclosure'
import type { EmbedMessage, WidgetMessage } from '../widget/messages'

const COMPOSER_HEIGHT = 130
const NO_LINKS: TaskLink[] = []
const noop = () => {}

function OpenInNewIcon() {
  return (
    <svg
      className="embed-title-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10" />
      <path d="M9 2h5v5M14 2 7.5 8.5" />
    </svg>
  )
}

export function EmbedPane({
  task,
  error,
  children,
}: {
  task: TaskWithProject | null
  error: string | null
  children?: ReactNode
}) {
  return (
    <div className="detail embed">
      {task && (
        <div className="embed-header">
          <a
            className="embed-title"
            href={taskHref(task.projectSlug, task.id)}
            title="Open in lander"
          >
            <span className="embed-title-text">{task.title}</span>
            <OpenInNewIcon />
          </a>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      {task ? children : !error && <div className="placeholder">Loading…</div>}
    </div>
  )
}

function useEmbeddedTask(taskRef: TaskRef, onPollError: (message: string | null) => void) {
  const { beginRefresh, ...fencedTasks } = useFencedTasks()
  const order = useRef(new MonotonicRequestGate())

  const load = useCallback(async () => {
    const request = order.current.begin()
    const commitRefresh = beginRefresh()
    try {
      const task = await loadTask(taskRef.projectSlug, taskRef.id)
      if (!order.current.settle(request)) return
      commitRefresh(() => [task])
      onPollError(null)
    } catch (e) {
      if (order.current.settle(request))
        onPollError(e instanceof Error ? e.message : String(e))
    }
  }, [taskRef, beginRefresh, onPollError])

  useEffect(() => {
    const poll = startPoll(load, POLL_GAP_MS)
    return () => {
      order.current.invalidate()
      poll.stop()
    }
  }, [load])

  return { ...fencedTasks, refresh: load }
}

// The widget's panel holds this page in a frame of another origin, and the
// two talk only through these messages.
const isFramed = () => window.parent !== window

// Sent to any origin, since the frame doesn't know the page's, and only a page
// lander lets frame the task can receive it.
const tellWidget = (message: EmbedMessage) => window.parent.postMessage(message, '*')

// Whether the widget's panel is open, and whether it's in view, as the widget
// reports them. The frame's own focus can't decide either: the panel is read
// without being clicked into, and a closed panel's frame still runs.
function useWidgetView(): { open: boolean; active: boolean } {
  const [view, setView] = useState({ open: false, active: false })
  useEffect(() => {
    if (!isFramed()) return
    const onMessage = (event: MessageEvent<WidgetMessage | undefined>) => {
      if (event.source === window.parent && event.data?.type === 'lander-widget-view')
        setView({ open: event.data.open === true, active: event.data.active === true })
    }
    // Focus leaving this frame for another window fires nothing on the page
    // around it, so this tells the widget to look again.
    const onFocusChange = () => tellWidget({ type: 'lander-embed-focus' })
    window.addEventListener('message', onMessage)
    window.addEventListener('focus', onFocusChange)
    window.addEventListener('blur', onFocusChange)
    tellWidget({ type: 'lander-embed-ready' })
    return () => {
      window.removeEventListener('message', onMessage)
      window.removeEventListener('focus', onFocusChange)
      window.removeEventListener('blur', onFocusChange)
    }
  }, [])
  return view
}

const openGalleryInWidget = (gallery: Gallery) =>
  tellWidget({ type: 'lander-embed-preview', gallery })

// The page the widget's preview frame holds: an attachment preview over the
// whole of the app's page, opened from the panel's conversation.
export function EmbedPreview({ projectSlug }: { projectSlug: string }) {
  const [gallery, setGallery] = useState<Gallery | null>(null)
  const load = useCallback(
    (file: Attachment) => loadAttachment(projectSlug, file.id),
    [projectSlug],
  )
  useEffect(() => {
    const onMessage = (event: MessageEvent<WidgetMessage | undefined>) => {
      if (event.source === window.parent && event.data?.type === 'lander-widget-preview')
        setGallery(event.data.gallery)
    }
    window.addEventListener('message', onMessage)
    tellWidget({ type: 'lander-preview-ready' })
    return () => window.removeEventListener('message', onMessage)
  }, [])
  const close = useCallback(() => {
    setGallery(null)
    tellWidget({ type: 'lander-preview-closed' })
  }, [])
  if (!gallery) return null
  return (
    <GalleryModal
      gallery={gallery}
      load={load}
      onSelect={(index) => setGallery({ ...gallery, index })}
      onClose={close}
    />
  )
}

// What the widget's button shows.
function useReportToWidget(task: TaskWithProject | null) {
  const unread = task ? isUnread(task) : false
  const riding = task?.status === 'riding'
  useEffect(() => {
    if (isFramed()) tellWidget({ type: 'lander-task-state', unread, riding })
  }, [unread, riding])
}

export function EmbedTask({ taskRef }: { taskRef: TaskRef }) {
  const [error, setError] = useState<string | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)
  const { refresh, ...fencedTasks } = useEmbeddedTask(taskRef, setPollError)
  const { tasks } = fencedTasks
  const task = tasks[0] ?? null
  const currentRef = useRef(task)
  currentRef.current = task

  const { markSeen, runTaskAction, allowTool, tryAgain, answerAsk, answeringBy } =
    useTaskActions({ currentRef, refresh, setError, ...fencedTasks })
  const { readUpTo, setReadUpTo, tabActive } = useViewingState(DEFAULT_VIEW, tasks)
  const widget = useWidgetView()
  const framed = isFramed()
  useReadMarker({
    current: task,
    readUpTo,
    tabActive: framed ? widget.active : tabActive,
    markSeen,
  })
  useReportToWidget(task)
  const disclosure = useTimelineDisclosure(task)
  const draft = useReplyDrafts(task, {
    setError,
    onSent: noop,
    refresh,
    taskLinks: NO_LINKS,
    taskLinksLoaded: false,
  })

  return (
    <EmbedPane task={task} error={error ?? pollError}>
      {task && (
        <ErrorBoundary label="this task">
          <OpenGalleryContext.Provider value={framed ? openGalleryInWidget : null}>
          {/* Rendered only while the panel is open, so each opening lays it out
              and scrolls to the first unread entry, as opening a task does. */}
          {(!framed || widget.open) && <Conversation
            task={task}
            grants={NO_GRANTS}
            disclosure={disclosure}
            reveal={null}
            answering={answeringBy[taskKeyOf(task)] ?? false}
            onReadUpTo={setReadUpTo}
            allowTool={allowTool}
            answerAsk={answerAsk}
            onTaskAction={runTaskAction}
            onRetry={tryAgain}
          />}
          </OpenGalleryContext.Provider>
          {draft && (
            <Composer task={task} height={COMPOSER_HEIGHT} draft={draft} showUsage={false} />
          )}
        </ErrorBoundary>
      )}
    </EmbedPane>
  )
}
