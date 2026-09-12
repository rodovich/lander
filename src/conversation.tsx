import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { AskForm } from './asks'
import { MessageAttachments } from './attachments'
import { conversationMarkdown } from './conversationMarkdown'
import { DetailHeader } from './detailHeader'
import { LifecycleNote } from './lifecycleNote'
import type { TaskLinkResolver } from './markdown'
import type { TaskAction } from './taskActions'
import { MessageBubble } from './messageBubble'
import { MessageText } from './messageText'
import { tick, timed } from './perf'
import { RideTurn } from './rideTurn'
import { TaskActionNote } from './taskActionNote'
import { openRide, taskAgentModelName } from './taskMeta'
import { taskKeyOf } from './taskRef'
import { buildTimeline } from './timeline'
import type { AskItem, TaskWithProject } from './types'

// The open task's pane: its header (see DetailHeader) above the scrolling
// timeline of user bubbles, ride turns, asks, and lifecycle events, pinned to
// the latest content while the reader is at the bottom. Owns the timeline's own
// view state — revealed tool details, expanded folds — and resets it when the
// task switches. Memoized: the parent re-renders on every poll and scroll flip,
// but this only re-renders when the task data (or one of the stable callbacks'
// rare identities) changes.
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

  // Collapse revealed tool details and expanded turns when switching tasks, so
  // neither bleeds across them and each task opens with its history folded down
  // again.
  useEffect(() => {
    setOpenDetails(new Set())
    setExpandedTurns(new Set())
  }, [task.id, task.projectSlug])

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
    const key = taskKeyOf(task)
    const switched = prevTaskIdRef.current !== key
    prevTaskIdRef.current = key
    if (switched) atBottomRef.current = true
    if (switched || atBottomRef.current) {
      el.scrollTop = el.scrollHeight
      // Pinning leaves us at the bottom; mirror that into the state the
      // active-viewing logic reads (a no-op when already true).
      onAtBottomChange(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.projectSlug, itemCount, streamSignal])

  return (
    <>
      <DetailHeader
        task={task}
        projectLabel={projectLabel}
        retitling={retitling}
        copyMarkdown={() =>
          conversationMarkdown({ task, timeline, openDetails, expandedTurns })
        }
        onTaskAction={onTaskAction}
        saveTitle={saveTitle}
        generateTitle={generateTitle}
        allowTool={allowTool}
        setAllowEdits={setAllowEdits}
      />
      <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
        {timeline.map((entry) => {
          if (entry.kind === 'event') {
            return (
              <LifecycleNote
                key={`e-${entry.event.id}`}
                event={entry.event}
                slug={task.projectSlug}
                linkTask={linkTask}
              />
            )
          }
          if (entry.kind === 'task-action') {
            // An action with no turn to sit in — the task had no ride open when
            // it acted, or that ride streamed nothing. Everything else reaches
            // the reader inside its RideTurn.
            return (
              <TaskActionNote
                key={`ta-${entry.action.id}`}
                item={entry.action}
                linkTask={linkTask}
              />
            )
          }
          if (entry.kind === 'ask') {
            // A platform ask, standing where it was raised: its prompt is
            // the account of what happened, and AskForm drops the buttons
            // once it's no longer open.
            return (
              <MessageBubble
                key={`a-${entry.ask.id}`}
                role="lander"
                at={entry.ask.at}
                variant="message-platform"
              >
                <AskForm
                  ask={entry.ask}
                  linkTask={linkTask}
                  disabled={answering}
                  onAnswer={(body) => void answerAsk(entry.ask.id, body)}
                />
              </MessageBubble>
            )
          }
          if (entry.kind === 'hook') {
            // A hook's report, in the platform's voice like a standalone ask:
            // the run had no task and no ride of its own, so this is its only
            // account of itself. The hook is named because a project may
            // declare several, and the outcome because "found nothing" and
            // "could not run" are different answers.
            const h = entry.hook
            return (
              <MessageBubble
                key={`h-${h.id}`}
                role={`hook ${h.hook}`}
                at={h.at}
                variant="message-platform"
              >
                {h.text && <MessageText text={h.text} linkTask={linkTask} />}
                {h.error && <div className="hook-error">{h.error}</div>}
                {h.output && <pre className="hook-output">{h.output}</pre>}
              </MessageBubble>
            )
          }
          if (entry.kind === 'user') {
            const m = entry.item
            // A hook's nudge sits in the same slot as a typed message — it was
            // queued and drove a turn the same way — but it is not the user
            // speaking, so it gets its own voice rather than the user's tint.
            const isHook = m.role === 'hook'
            return (
              <MessageBubble
                key={`u-${m.id}`}
                role={isHook ? `hook ${m.from?.hook ?? ''}`.trim() : 'user'}
                at={m.at}
                variant={
                  `message-${isHook ? 'hook' : 'user'}` +
                  (m.queued ? ' message-queued' : '')
                }
              >
                <MessageText text={m.text} linkTask={linkTask} />
                {m.attachments && m.attachments.length > 0 && (
                  <MessageAttachments
                    attachments={m.attachments}
                    slug={task.projectSlug}
                  />
                )}
              </MessageBubble>
            )
          }
          // A ride — one assistant turn, carrying all its items.
          return (
            <RideTurn
              key={`r-${entry.ride.id}`}
              ride={entry.ride}
              items={entry.items}
              actions={entry.actions}
              agent={task.flow ?? task.agent}
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
