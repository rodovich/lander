import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AskForm } from './asks'
import { MessageAttachments } from './attachments'
import { formatTimestamp } from './format'
import { GrantControl } from './grants'
import type { TaskLinkResolver } from './markdown'
import { CopyIdButton, ReadOnlyMenu, TaskActionsMenu } from './menus'
import type { TaskAction } from './menus'
import { MessageText } from './messageText'
import { tick, timed } from './perf'
import { RideTurn } from './rideTurn'
import { StatusTransition } from './statusTransition'
import { taskAgentModelName } from './taskMeta'
import { buildTimeline } from './timeline'
import type { AskItem, Ride, TaskWithProject } from './types'

// The task's currently-open ride (the last one without an `endedAt`), if any —
// the in-flight turn. Mirrors the server's openRide; drives the trailing spinner
// and the stream-pinning signal.
function openRide(task: { rides?: Ride[] } | null | undefined): Ride | undefined {
  const rides = task?.rides
  if (!rides) return undefined
  for (let i = rides.length - 1; i >= 0; i--)
    if (!rides[i].endedAt) return rides[i]
  return undefined
}

// The open task's pane: the detail header (title editing, grants, kebab) and
// the scrolling timeline of user bubbles, ride turns, asks, and lifecycle
// events, pinned to the latest content while the reader is at the bottom.
// Owns all per-task view state (title edit mode, revealed tool details,
// expanded folds), reset when the task switches. Memoized: the parent
// re-renders on every poll and scroll flip, but this only re-renders when the
// task data (or one of the stable callbacks' rare identities) changes.
export const Conversation = memo(function Conversation({
  task,
  projectLabel,
  linkTask,
  retitling,
  answering,
  onAtBottomChange,
  onTaskAction,
  saveTitle,
  generateTitle,
  allowTool,
  setAllowEdits,
  answerAsk,
}: {
  task: TaskWithProject
  // "project • worktree" for the line above the title, or null to omit it.
  projectLabel: string | null
  linkTask: TaskLinkResolver
  retitling: string | null
  answering: boolean
  onAtBottomChange: (atBottom: boolean) => void
  onTaskAction: (task: TaskWithProject, action: TaskAction) => void
  saveTitle: (draft: string) => Promise<void>
  generateTitle: () => Promise<void>
  allowTool: (rule: string, scope: 'task' | 'project') => Promise<boolean>
  setAllowEdits: (checked: boolean) => Promise<void>
  answerAsk: (
    askId: string,
    body: { optionId?: string; text?: string },
  ) => Promise<void>
}) {
  // Opt-in profiling (see perf.ts): count re-renders of the conversation pane
  // separately from App's own churn — a high count against little task
  // activity means the memo props aren't holding still.
  tick('Conversation.render')

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  // The set of tool chips whose detail (a diff or captured output) is revealed,
  // keyed by the tool item's stable id. Details start closed and several can be
  // open at once (option/shift-click toggles a whole ride's worth).
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set())

  // Toggle one chip's detail, or — when option/shift was held — every detail in
  // its ride together, driving them all to this chip's new (opposite) state.
  function toggleDetail(key: string, rideKeys: string[]) {
    setOpenDetails((prev) => {
      const next = new Set(prev)
      const willOpen = !prev.has(key)
      for (const k of rideKeys) {
        if (willOpen) next.add(k)
        else next.delete(k)
      }
      return next
    })
  }

  // Assistant turns (other than the most recent) collapse their middle stretch of
  // items behind a disclosure; this holds the fold keys the viewer has expanded.
  // It's cleared on task switch, so each task opens with its history folded down
  // again.
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set())

  function toggleTurn(segKey: string) {
    setExpandedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(segKey)) next.delete(segKey)
      else next.add(segKey)
      return next
    })
  }

  // Reset per-task view state when switching tasks so none of it bleeds across
  // them: leave title-edit mode and collapse revealed tool details and expanded
  // turns.
  useEffect(() => {
    setEditingTitle(false)
    setOpenDetails(new Set())
    setExpandedTurns(new Set())
  }, [task.id])

  // Focus and select the title when entering edit mode.
  useEffect(() => {
    if (editingTitle) {
      const el = titleInputRef.current
      el?.focus()
      el?.select()
    }
  }, [editingTitle])

  function startTitleEdit() {
    setTitleDraft(task.title)
    setEditingTitle(true)
  }

  function onTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      setEditingTitle(false)
      void saveTitle(titleDraft)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditingTitle(false)
    }
  }

  // The task's conversation as a single stream: user bubbles, ride turns,
  // and lifecycle events in order. The ordering rules (ride grouping, queued
  // sinking, in-flight anchoring) all live in buildTimeline; `now` anchors any
  // in-flight turn. Keyed on the task object: a poll delivers a fresh one every
  // 2s, so `now` never goes staler than that, while local state changes (a
  // detail toggle, title typing) reuse the memoized stream.
  const timeline = useMemo(
    () =>
      timed(
        'buildTimeline',
        () => buildTimeline(task, new Date().toISOString()),
        `${task.items?.length ?? 0} items`,
      ).items,
    [task],
  )

  // The task's open ask renders as the footer of the ride that raised it
  // (the message is the question, the form is the answer). There's at most one
  // open ask. An ask with no ride to hang under — a platform ask, or converted
  // history — isn't handled that way at all: buildTimeline gives it its own
  // entry in the stream.
  const openAsk = task.items?.find(
    (it): it is AskItem => it.kind === 'ask' && it.state === 'open',
  )

  // Whether the in-flight ride has already produced any item. When it has, the
  // ride block renders its own trailing "working…" spinner; when it hasn't (the
  // run was just handed off), the standalone "starting…" row stands in.
  const openR = openRide(task)
  const openRideHasItems =
    !!openR && (task.items?.some((it) => it.rideId === openR.id) ?? false)

  // Keep the conversation pinned to the latest content. We always jump to the
  // bottom when switching tasks, but when new content streams in we only follow
  // along if the reader was already at the bottom — otherwise scrolling up to
  // read earlier messages would be yanked back down on every poll.
  const messagesRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const prevTaskIdRef = useRef<string | null>(null)

  function onMessagesScroll() {
    // Fires on every scroll frame; the at-bottom flip re-renders App, though
    // the memoized panes hold still unless their props changed. Counted so the
    // profile shows scroll-driven churn separately from poll/stream churn.
    tick('scroll.event')
    const el = messagesRef.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
    atBottomRef.current = bottom
    onAtBottomChange(bottom)
  }

  // Changes whenever the task's in-flight ride grows — a new item, or the
  // last item's text/output filling in — so the effect re-pins as an assistant
  // turn streams. The open-ride flag tracks the trailing working-spinner row,
  // which adds and removes a row (changing the timeline's height) without any
  // item text changing, so the effect must re-pin for that too.
  const itemCount = task.items?.length ?? 0
  const streamLen =
    task.items?.reduce(
      (n, it) =>
        n +
        (it.kind === 'message'
          ? it.text.length
          : it.kind === 'tool'
            ? it.input.length + (it.output?.length ?? 0)
            : 0),
      0,
    ) ?? 0
  const streamSignal = `${itemCount}:${streamLen}:${task.status}:${
    openR ? 1 : 0
  }`

  useEffect(() => {
    const el = messagesRef.current
    if (!el) return
    const switched = prevTaskIdRef.current !== task.id
    prevTaskIdRef.current = task.id
    if (switched) atBottomRef.current = true
    if (switched || atBottomRef.current) {
      el.scrollTop = el.scrollHeight
      // Pinning leaves us at the bottom; mirror that into the state the
      // active-viewing logic reads (a no-op when already true).
      onAtBottomChange(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, itemCount, streamSignal])

  return (
    <>
      <div className="detail-header">
        {projectLabel && <div className="detail-project">{projectLabel}</div>}
        {editingTitle ? (
          <input
            ref={titleInputRef}
            className="title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={onTitleKeyDown}
            onBlur={() => setEditingTitle(false)}
          />
        ) : (
          <div className="title-row">
            <h1
              className="editable-title"
              title="Click to edit title"
              onClick={startTitleEdit}
            >
              {task.title}
            </h1>
            <button
              className="edit-title-button"
              title="Regenerate title"
              aria-label="Regenerate title"
              disabled={retitling === task.id}
              onClick={() => void generateTitle()}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M8 1.5l1.4 3.6 3.6 1.4-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4z" />
                <path d="M13 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
              </svg>
            </button>
            <CopyIdButton id={task.id} />
            {!task.archived && (
              <GrantControl grants={task.grants} onAllow={allowTool} />
            )}
            {!task.allowEdits && !task.archived && (
              <ReadOnlyMenu onAllowEdits={() => void setAllowEdits(true)} />
            )}
            <TaskActionsMenu
              task={task}
              onAction={(action) => onTaskAction(task, action)}
            />
          </div>
        )}
        <div className="detail-meta">
          <span
            className={
              'task-status' +
              (task.status === 'wedged' ? ' wedged' : '') +
              (task.status === 'riding' ? ' riding' : '') +
              (task.status === 'resting' ? ' resting' : '') +
              (task.status === 'landed' ? ' landed' : '')
            }
          >
            {task.status}
          </span>
          <span className="task-time">
            {formatTimestamp(task.updatedAt ?? task.createdAt)}
          </span>
        </div>
      </div>
      <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
        {timeline.map((entry) => {
          if (entry.kind === 'event') {
            return (
              <StatusTransition
                key={`e-${entry.event.id}`}
                event={entry.event}
                slug={task.projectSlug}
                linkTask={linkTask}
              />
            )
          }
          if (entry.kind === 'ask') {
            // A platform ask, standing where it was raised: its prompt is
            // the account of what happened, and AskForm drops the buttons
            // once it's no longer open. It carries a head like every other
            // row because it outlives its form — a bare sentence with no
            // time on it reads as floating loose in the conversation rather
            // than as the record of a moment.
            return (
              <div
                className="message message-platform"
                key={`a-${entry.ask.id}`}
              >
                <div className="message-head">
                  <span className="message-role">lander</span>
                  <span className="message-time">
                    {formatTimestamp(entry.ask.at)}
                  </span>
                </div>
                <AskForm
                  ask={entry.ask}
                  linkTask={linkTask}
                  disabled={answering}
                  onAnswer={(body) => void answerAsk(entry.ask.id, body)}
                />
              </div>
            )
          }
          if (entry.kind === 'user') {
            const m = entry.item
            return (
              <div
                className={`message message-user${m.queued ? ' message-queued' : ''}`}
                key={`u-${m.id}`}
              >
                <div className="message-head">
                  <span className="message-role">user</span>
                  <span className="message-time">{formatTimestamp(m.at)}</span>
                </div>
                <MessageText text={m.text} linkTask={linkTask} />
                {m.attachments && m.attachments.length > 0 && (
                  <MessageAttachments
                    attachments={m.attachments}
                    slug={task.projectSlug}
                  />
                )}
              </div>
            )
          }
          // A ride — one assistant turn, carrying all its items.
          return (
            <RideTurn
              key={`r-${entry.ride.id}`}
              ride={entry.ride}
              items={entry.items}
              agent={task.flow ?? task.agent}
              taskId={task.id}
              slug={task.projectSlug}
              grants={task.grants}
              linkTask={linkTask}
              openDetails={openDetails}
              onToggleDetail={toggleDetail}
              expandedTurns={expandedTurns}
              onToggleTurn={toggleTurn}
              openAsk={openAsk}
              answering={answering}
              onAnswerAsk={(askId, body) => void answerAsk(askId, body)}
              onAllow={allowTool}
            />
          )
        })}
        {/* No ride output yet but the task is riding: the assistant has been
            launched and we're waiting for its first item. The model isn't
            known until that output arrives, so this stays model-agnostic. */}
        {task.status === 'riding' && !openRideHasItems && (
          <div className="message">
            <div className="message-pending">
              <span className="spinner" aria-hidden />
              {`${taskAgentModelName(task.flow ?? task.agent)} is starting…`}
            </div>
          </div>
        )}
      </div>
    </>
  )
})
