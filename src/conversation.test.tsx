import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { Conversation } from './conversation'
import type {
  AskItem,
  EventItem,
  Item,
  MessageItem,
  Ride,
  TaskActionItem,
  TaskWithProject,
} from './types'

// Static markup covers what this suite is after: the timeline's entry-kind
// dispatch (which component each entry renders as). Ordering itself is
// timeline.test.ts's business, the header is detailHeader.test.tsx's, and
// scroll pinning needs a real DOM and is left to manual verification.
const T = (clock: string) => `2026-06-26T${clock}.000Z`
const AT = T('10:00:00')

const user = (id: string, text: string, over: Partial<MessageItem> = {}): MessageItem => ({
  id,
  at: AT,
  kind: 'message',
  role: 'user',
  text,
  ...over,
})
const flow = (id: string, rideId: string, text: string): MessageItem => ({
  id,
  at: AT,
  rideId,
  kind: 'message',
  role: 'flow',
  text,
})
const ev = (id: string, eventKind: EventItem['eventKind']): EventItem => ({
  id,
  at: AT,
  kind: 'event',
  eventKind,
})
const ask = (id: string, over: Partial<AskItem> = {}): AskItem => ({
  id,
  at: AT,
  kind: 'ask',
  prompt: 'what next?',
  form: { type: 'choice', options: [{ id: 'a', label: 'Alpha-option' }] },
  blocking: 'task',
  state: 'open',
  ...over,
})
const taskAction = (id: string): TaskActionItem => ({
  id,
  at: AT,
  kind: 'task-action',
  action: 'launch',
  target: { id: 'child', projectSlug: 'other', title: 'Child task' },
})
const ride = (id: string, over: Partial<Ride> = {}): Ride => ({
  id,
  startedAt: AT,
  endedAt: T('10:05:00'),
  outcome: 'done',
  ...over,
})

const baseTask = (over: Partial<TaskWithProject> = {}): TaskWithProject => ({
  id: 'task1',
  agent: 'claude',
  title: 'Fix the parser',
  status: 'paced',
  createdAt: AT,
  projectSlug: 'proj',
  items: [],
  rides: [],
  ...over,
})

const render = (
  task: TaskWithProject,
  over: Partial<ComponentProps<typeof Conversation>> = {},
) =>
  renderToStaticMarkup(
    <Conversation
      task={task}
      disclosure={{
        openDetails: new Set(),
        expandedTurns: new Set(),
        toggleDetail: () => {},
        toggleTurn: () => {},
      }}
      reveal={null}
      answering={false}
      onReadUpTo={() => {}}
      allowTool={async () => true}
      answerAsk={async () => {}}
      onTaskAction={() => {}}
      onRetry={async () => true}
      {...over}
    />,
  )

describe('Conversation timeline dispatch', () => {
  it('renders context markers inside a folded turn without tool chips', () => {
    const html = render(baseTask({
      items: [
        flow('before', 'r1', 'Before'),
        { id: 'compact', at: AT, rideId: 'r1', kind: 'context', action: 'compaction',
          trigger: 'auto', beforeTokens: 182000, afterTokens: 24000, durationMs: 1250 },
        { id: 'checkpoint', at: AT, rideId: 'r1', kind: 'context', action: 'checkpoint' },
        flow('after', 'r1', 'After'),
      ],
      rides: [ride('r1')],
    }))
    expect(html).toContain('Context compacted')
    expect(html).toContain('automatic · 182,000 → 24,000 tokens')
    expect(html).toContain('Context checkpoint created')
    expect(html).toContain('Show context change details')
    expect(html).not.toContain('tool-step')
  })

  it('shows compacting only on an open ride and otherwise uses the working indicator', () => {
    const html = (over: Partial<Ride>) => render(baseTask({
      status: 'riding', items: [flow('f1', 'r1', 'Before')],
      rides: [ride('r1', { endedAt: undefined, outcome: undefined, ...over })],
    }))
    expect(html({ compacting: true })).toContain('Compacting context…')
    expect(html({})).toContain('is working…')
    expect(html({ compacting: true, endedAt: AT, outcome: 'interrupted' })).not.toContain('Compacting context…')
    const beforeOutput = render(baseTask({
      status: 'riding', items: [],
      rides: [ride('r1', { endedAt: undefined, outcome: undefined, compacting: true })],
    }))
    expect(beforeOutput).toContain('Compacting context…')
    expect(beforeOutput).not.toContain('is starting…')
  })
  it('renders each entry kind as its own row component', () => {
    const html = render(
      baseTask({
        items: [
          user('u1', 'user-question'),
          flow('f1', 'r1', 'assistant-answer'),
          ev('e1', 'landed'),
          taskAction('ta1'),
        ],
        rides: [ride('r1')],
      }),
    )
    expect(html).toContain('message-user')
    expect(html).toContain('>you<')
    expect(html).toContain('user-question')
    expect(html).toContain('message-assistant')
    expect(html).toContain('>agent<')
    expect(html).toContain('assistant-answer')
    // A lifecycle transition and a task action share one row component, so they
    // are told apart by what they say, not by a class of their own.
    expect(html).toContain('timeline-note')
    expect(html).toContain('>landed<')
    expect(html).toContain('launched task')
  })

  // A hook's nudge sits in the same slot as a typed message — it was queued and
  // it drove a turn — but it is not the user speaking. Rendered in the user's
  // voice it would be indistinguishable from something the human asked for.
  it('renders a hook’s nudge in its own voice, not the user’s', () => {
    const html = render(
      baseTask({
        items: [
          {
            ...user('h1', 'From hook supervise:\n\nreally finished?'),
            role: 'hook',
            from: {
              hook: 'supervise',
              path: '.lander/hooks/ride-ended/any/supervise.js',
              fireId: 'fire-1',
            },
          } as MessageItem,
        ],
      }),
    )
    expect(html).toContain('message-hook')
    expect(html).not.toContain('message-user')
    expect(html).toContain('hook supervise')
    expect(html).toContain('really finished?')
  })

  // Another task's message is not the user's either: a note naming the sender,
  // its words folded behind the disclosure — until a search match lands in it.
  it('renders another task’s message as a folded note naming its sender', () => {
    const sent = user('s1', 'sender-words', {
      from: { task: 'sender-task', via: 'notify' },
      queued: true,
    })
    const html = render(baseTask({ items: [sent] }))
    expect(html).not.toContain('message-user')
    expect(html).toContain('received message from')
    expect(html).toContain('href="/proj/sender-task"')
    expect(html).toContain('timeline-note message-queued')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('sender-words')

    const revealed = render(baseTask({ items: [sent] }), {
      reveal: { itemId: 's1', occurrence: 0, query: 'sender' },
    })
    expect(revealed).toContain('aria-expanded="true"')
    expect(revealed).toContain('data-item-id="s1"')
    expect(revealed).toContain('sender-words')
  })

  // A relaunch's brief is the task's own words to its next session: told inside
  // the divider that delivered it, folded, rather than as the user speaking.
  it('folds a relaunch’s brief into its relaunched note', () => {
    const brief = user('b1', 'brief-words', {
      from: { task: 'task1', via: 'relaunch' },
    })
    const items = [{ ...ev('e1', 'relaunched'), title: 'Fix the parser', message: 'b1' }, brief]
    const html = render(baseTask({ items }))
    expect(html).not.toContain('message-user')
    expect(html).toContain('Fix the parser <span class="timeline-note-label relaunched">relaunched')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('brief-words')

    const revealed = render(baseTask({ items }), {
      reveal: { itemId: 'b1', occurrence: 0, query: 'brief' },
    })
    expect(revealed).toContain('aria-expanded="true"')
    expect(revealed).toContain('data-item-id="b1"')
    expect(revealed).toContain('brief-words')
  })

  it('folds a wakeup’s notification into its notified note', () => {
    const notice = user('n1', 'Task landed: other', { from: { lander: 'await' } })
    const items = [{ ...ev('e1', 'notified'), title: 'Fix the parser', message: 'n1' }, notice]
    const html = render(baseTask({ items }))
    expect(html).not.toContain('message-user')
    expect(html).toContain('received a notification')
    expect(html).not.toContain('Task landed')
  })

  it('marks a queued follow-up bubble', () => {
    const html = render(
      baseTask({ items: [user('u1', 'later', { queued: true })] }),
    )
    expect(html).toContain('message-queued')
  })

  it('renders an unanchored ask as a timestamped platform row', () => {
    const html = render(baseTask({ items: [ask('k1')] }))
    expect(html).toContain('message-platform')
    expect(html).toContain('lander')
    expect(html).toContain('what next?')
    expect(html).toContain('Alpha-option')
  })

  it('hangs an anchored open ask off its ride as a footer, not a platform row', () => {
    const html = render(
      baseTask({
        items: [flow('f1', 'r1', 'shall I?'), ask('k1', { rideId: 'r1' })],
        rides: [ride('r1')],
      }),
    )
    expect(html).not.toContain('message-platform')
    // The form still renders — inside the assistant bubble.
    expect(html).toContain('Alpha-option')
  })
})

describe('Conversation pending rows', () => {
  it('shows the starting row while a riding task has no ride output yet', () => {
    const html = render(
      baseTask({
        status: 'riding',
        items: [user('u1', 'go')],
        rides: [ride('r1', { endedAt: undefined })],
      }),
    )
    expect(html).toContain('is starting…')
    expect(html).toContain('pending-pace')
  })

  it('hands off to the ride’s own working spinner once items arrive', () => {
    const html = render(
      baseTask({
        status: 'riding',
        items: [flow('f1', 'r1', 'thinking')],
        rides: [ride('r1', { endedAt: undefined })],
      }),
    )
    expect(html).toContain('is working…')
    expect(html).not.toContain('is starting…')
  })
})
