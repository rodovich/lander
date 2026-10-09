import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
import { AskForm } from './asks'
import { MessageAttachments } from './attachments'
import { LifecycleNote } from './lifecycleNote'
import { MessageBubble } from './messageBubble'
import { MessageText } from './messageText'
import { tick, timed } from './perf'
import { entryReadStamp, readThroughOf } from './readMarker'
import { PendingRow, RideTurn } from './rideTurn'
import type { TaskAction } from './taskActions'
import { SentMessageNote } from './sentMessageNote'
import { TaskActionNote } from './taskActionNote'
import { openRide, taskAgentModelName } from './taskMeta'
import { taskKeyOf } from './taskRef'
import { findTextRanges, paintRanges } from './textRanges'
import { buildTimeline, type TimelineEntry } from './timeline'
import type { AskItem, TaskWithProject } from './types'
import type { ReadUpTo } from './useReadMarker'
import type { TimelineDisclosure } from './useTimelineDisclosure'

// A timeline entry's React key, stable across polls.
function entryKey(entry: TimelineEntry): string {
  switch (entry.kind) {
    case 'event':
      return `e-${entry.event.id}`
    case 'task-action':
      return `ta-${entry.action.id}`
    case 'ask':
      return `a-${entry.ask.id}`
    case 'hook':
      return `h-${entry.hook.id}`
    case 'user':
      return `u-${entry.item.id}`
    case 'ride':
      return `r-${entry.ride.id}`
  }
}

// Whether the pane is scrolled to (within a few pixels of) its bottom.
function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 32
}

// Where a search match lies in a task's conversation: the item, which of the
// query's occurrences in it, and the query itself (lowercased).
export type ConversationReveal = {
  itemId: string
  occurrence: number
  query: string
}

// The open task's scrolling timeline of user bubbles, ride turns, asks, and
// lifecycle events, pinned to the latest content while the reader is at the
// bottom. What the reader has opened on it is `disclosure`, owned above so the
// header's conversation copy can read it too. Memoized: the parent re-renders
// on every poll and scroll flip, but this only re-renders when the task data,
// the disclosure, or one of the stable callbacks' rare identities changes.
export const Conversation = memo(function Conversation({
  task,
  disclosure,
  reveal,
  answering,
  onReadUpTo,
  allowTool,
  answerAsk,
  onTaskAction,
  onRetry,
}: {
  task: TaskWithProject
  disclosure: TimelineDisclosure
  // A search match on this task to bring into view, if one was just opened.
  reveal: ConversationReveal | null
  answering: boolean
  // How far the conversation is read, each time that moves (see measureRead).
  onReadUpTo: (readUpTo: ReadUpTo) => void
  allowTool: (rule: string, scope: 'task' | 'project') => Promise<boolean>
  answerAsk: (
    askId: string,
    body: { optionId?: string; text?: string },
  ) => Promise<void>
  onTaskAction: (task: TaskWithProject, action: TaskAction) => void
  onRetry: () => Promise<boolean>
}) {
  // Opt-in profiling (see perf.ts): count re-renders of the conversation pane
  // separately from App's own churn — a high count against little task
  // activity means the memo props aren't holding still.
  tick('Conversation.render')

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

  // The spinner rows' Pace button — the kebab menu's Pace, on this task.
  const pace = useCallback(
    () => onTaskAction(task, 'pace'),
    [task, onTaskAction],
  )
  const openRideHasItems =
    !!openR && (task.items?.some((it) => it.rideId === openR.id) ?? false)

  // Each timeline entry's read stamp (see readMarker.ts), in timeline order.
  const stamps = useMemo(
    () => timeline.map((e) => entryReadStamp(e, openR?.id)),
    [timeline, openR?.id],
  )

  // Keep the conversation pinned to the latest content. On switching tasks we
  // open at the first unread entry (or the bottom, when there's none), but when
  // new content streams in we only follow along if the reader was already at
  // the bottom — otherwise scrolling up to read earlier messages would be
  // yanked back down on every poll.
  const messagesRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const prevTaskIdRef = useRef<string | null>(null)

  // Measure how far the conversation is read and report it when it moves: the
  // marker reading every entry whose bottom edge is on screen or scrolled past
  // it. Entries stack in order, so those form a prefix, found by bisecting
  // their wrappers (the pane's first `timeline.length` children).
  const lastReadRef = useRef<ReadUpTo | null>(null)
  function measureRead() {
    const el = messagesRef.current
    if (!el) return
    const limit = el.getBoundingClientRect().bottom + 1
    let lo = 0
    let hi = Math.min(stamps.length, el.children.length)
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (el.children[mid].getBoundingClientRect().bottom <= limit) lo = mid + 1
      else hi = mid
    }
    const next = { key: taskKeyOf(task), at: readThroughOf(stamps, lo) }
    const last = lastReadRef.current
    if (last && last.key === next.key && last.at === next.at) return
    lastReadRef.current = next
    onReadUpTo(next)
  }
  const measureReadRef = useRef(measureRead)
  measureReadRef.current = measureRead

  function onMessagesScroll() {
    // Fires on every scroll frame; a change in what's read re-renders App,
    // though the memoized panes hold still unless their props changed. Counted
    // so the profile shows scroll-driven churn separately from poll/stream
    // churn.
    tick('scroll.event')
    const el = messagesRef.current
    if (!el) return
    atBottomRef.current = isAtBottom(el)
    measureRead()
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
    const marker = task.readThrough
    const unread =
      switched && marker != null
        ? stamps.findIndex((s) => s !== null && s > marker)
        : -1
    const target = unread >= 0 ? el.children[unread] : undefined
    if (target) {
      // Open at the top of the first unread entry.
      el.scrollTop +=
        target.getBoundingClientRect().top - el.getBoundingClientRect().top
      atBottomRef.current = isAtBottom(el)
    } else if (switched || atBottomRef.current) {
      el.scrollTop = el.scrollHeight
      atBottomRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.projectSlug, itemCount, streamSignal])

  // Re-measure what's read whenever the entries change (the pin above may have
  // moved them, or something new landed on screen) or the pane resizes.
  // Declared after the pin so it measures where the pin left the pane.
  useEffect(() => measureReadRef.current(), [stamps])
  useEffect(() => {
    const el = messagesRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => measureReadRef.current())
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Bring a search match into view: scroll its occurrence a third of the way
  // down the pane and paint every occurrence in its item, until the reveal
  // changes or the task does. Declared after the pin above so that, on the
  // switch a match's click makes, it scrolls after the pin's own scroll. An
  // occurrence the rendered text no longer holds (markdown can split or drop
  // it) falls back to the nearest one, then to the item itself.
  useEffect(() => {
    const el = messagesRef.current
    if (!el || !reveal) return
    const target = el.querySelector(
      `[data-item-id="${CSS.escape(reveal.itemId)}"]`,
    )
    if (!target) return
    const ranges = findTextRanges(target, reveal.query)
    const spot = ranges[Math.min(reveal.occurrence, ranges.length - 1)] ?? target
    el.scrollTop +=
      spot.getBoundingClientRect().top -
      el.getBoundingClientRect().top -
      el.clientHeight / 3
    onMessagesScroll()
    return paintRanges('text-highlight', ranges)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal])

  function renderEntry(entry: TimelineEntry) {
    if (entry.kind === 'event') {
      return (
        <LifecycleNote
          event={entry.event}
          message={entry.message}
          slug={task.projectSlug}
          openOn={
            entry.message && reveal?.itemId === entry.message.id
              ? reveal
              : undefined
          }
        />
      )
    }
    if (entry.kind === 'task-action') {
      // An action with no turn to sit in — the task had no ride open when it
      // acted, or that ride streamed nothing. Everything else reaches the
      // reader inside its RideTurn.
      return <TaskActionNote item={entry.action} />
    }
    if (entry.kind === 'ask') {
      // A platform ask, standing where it was raised: its prompt is the
      // account of what happened, and AskForm drops the buttons once it's no
      // longer open.
      return (
        <MessageBubble
          role="lander"
          at={entry.ask.at}
          variant="message-platform"
        >
          <AskForm
            ask={entry.ask}
            disabled={answering}
            onAnswer={(body) => void answerAsk(entry.ask.id, body)}
          />
        </MessageBubble>
      )
    }
    if (entry.kind === 'hook') {
      // A hook's report, in the platform's voice like a standalone ask: the
      // run had no task and no ride of its own, so this is its only account
      // of itself. The hook is named because a project may declare several,
      // and the outcome because "found nothing" and "could not run" are
      // different answers.
      const h = entry.hook
      return (
        <MessageBubble
          role={`hook ${h.hook}`}
          at={h.at}
          variant="message-platform"
          itemId={h.id}
        >
          {h.text && <MessageText text={h.text} />}
          {h.error && <div className="hook-error">{h.error}</div>}
          {h.output && <pre className="hook-output">{h.output}</pre>}
        </MessageBubble>
      )
    }
    if (entry.kind === 'user') {
      const m = entry.item
      if (m.from && 'task' in m.from)
        return (
          <SentMessageNote
            item={m}
            sender={m.from.task}
            slug={task.projectSlug}
            openOn={reveal?.itemId === m.id ? reveal : undefined}
          />
        )
      // A hook's nudge sits in the same slot as a typed message — it was
      // queued and drove a turn the same way — but it is not the user
      // speaking, so it gets its own voice rather than the user's tint.
      const isHook = m.role === 'hook'
      return (
        <MessageBubble
          role={
            isHook
              ? `hook ${m.from && 'hook' in m.from ? m.from.hook : ''}`.trim()
              : 'you'
          }
          at={m.at}
          itemId={m.id}
          variant={
            `message-${isHook ? 'hook' : 'user'}` +
            (m.queued ? ' message-queued' : '')
          }
        >
          <MessageText text={m.text} />
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
        ride={entry.ride}
        items={entry.items}
        actions={entry.actions}
        agent={task.flow ?? task.agent}
        slug={task.projectSlug}
        grants={task.grants}
        disclosure={disclosure}
        openAsk={openAsk}
        answering={answering}
        onAnswerAsk={answerAsk}
        onAllow={allowTool}
        onRetry={!task.archived && (task.status === 'wedged' || task.status === 'paced') ? onRetry : undefined}
        onPace={pace}
      />
    )
  }

  return (
    <div className="messages" ref={messagesRef} onScroll={onMessagesScroll}>
      {/* Each entry in a bare wrapper, so the read measurement and the
          open-at-first-unread scroll can find it by its index. */}
      {timeline.map((entry) => (
        <div key={entryKey(entry)} className="timeline-entry">
          {renderEntry(entry)}
        </div>
      ))}
      {/* No ride output yet but the task is riding: the assistant has been
          launched and we're waiting for its first item. The model isn't
          known until that output arrives, so this stays model-agnostic. */}
      {task.status === 'riding' && !openRideHasItems && (
        <div className="message">
          <PendingRow onPace={pace}>
            {`${taskAgentModelName(task.flow ?? task.agent)} is starting…`}
          </PendingRow>
        </div>
      )}
    </div>
  )
})
