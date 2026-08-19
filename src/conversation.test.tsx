import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { Conversation } from './conversation'
import type { AskItem, EventItem, Item, MessageItem, Ride, TaskWithProject } from './types'

// Static markup covers what this suite is after: the header states and the
// timeline's entry-kind dispatch (which component each entry renders as).
// Ordering itself is timeline.test.ts's business; scroll pinning needs a real
// DOM and is left to manual verification.
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
  status: 'resting',
  createdAt: AT,
  allowEdits: true,
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
      projectLabel={null}
      linkTask={() => undefined}
      retitling={null}
      answering={false}
      onAtBottomChange={() => {}}
      onTaskAction={() => {}}
      saveTitle={async () => {}}
      generateTitle={async () => {}}
      allowTool={async () => true}
      setAllowEdits={async () => {}}
      answerAsk={async () => {}}
      {...over}
    />,
  )

describe('Conversation header', () => {
  it('renders the title, status, and the project label only when given', () => {
    const html = render(baseTask({ status: 'wedged' }), {
      projectLabel: 'proj • wt-fix',
    })
    expect(html).toContain('Fix the parser')
    expect(html).toContain('task-status wedged')
    expect(html).toContain('proj • wt-fix')
    expect(render(baseTask())).not.toContain('detail-project')
  })

  it('hides the grant and read-only controls on an archived task', () => {
    const active = render(baseTask({ allowEdits: false }))
    expect(active).toContain('Read-only')
    const archived = render(baseTask({ allowEdits: false, archived: true }))
    expect(archived).not.toContain('Read-only')
  })
})

describe('Conversation timeline dispatch', () => {
  it('renders each entry kind as its own row component', () => {
    const html = render(
      baseTask({
        items: [
          user('u1', 'user-question'),
          flow('f1', 'r1', 'assistant-answer'),
          ev('e1', 'landed'),
        ],
        rides: [ride('r1')],
      }),
    )
    expect(html).toContain('message-user')
    expect(html).toContain('user-question')
    expect(html).toContain('message-assistant')
    expect(html).toContain('assistant-answer')
    expect(html).toContain('status-transition')
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
