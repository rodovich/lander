import { describe, it, expect } from 'vitest'
import { buildTimeline } from './timeline'
import type {
  AskItem,
  EventItem,
  Item,
  MessageItem,
  Ride,
  TaskActionItem,
  ToolItem,
} from './types'

// Pick clearly-ordered ISO timestamps without hand-writing the date each time.
const T = (clock: string) => `2026-06-26T${clock}.000Z`

// Item/ride builders. Ids double as the tags the order assertions read back.
const user = (id: string, at: string, queued = false): MessageItem => ({
  id,
  at,
  kind: 'message',
  role: 'user',
  text: id,
  ...(queued ? { queued: true } : {}),
})
const flow = (id: string, rideId: string, at: string): MessageItem => ({
  id,
  at,
  rideId,
  kind: 'message',
  role: 'flow',
  text: id,
})
const tool = (id: string, rideId: string, at: string): ToolItem => ({
  id,
  at,
  rideId,
  kind: 'tool',
  name: 'Bash',
  input: 'ls',
  status: 'ok',
})
const ev = (eventKind: EventItem['eventKind'], at: string): EventItem => ({
  id: `itm-${eventKind}-${at}`,
  at,
  kind: 'event',
  eventKind,
})
const action = (id: string, at: string, ride?: string): TaskActionItem => ({
  id,
  at,
  kind: 'task-action',
  ...(ride ? { ride } : {}),
  action: 'launch',
  target: { id: 'child', projectSlug: 'proj' },
})
const ride = (id: string, startedAt: string, endedAt?: string): Ride => ({
  id,
  startedAt,
  ...(endedAt ? { endedAt, outcome: 'done' } : {}),
})
const ask = (id: string, at: string, over: Partial<AskItem> = {}): AskItem => ({
  id,
  at,
  kind: 'ask',
  form: { type: 'choice', options: [{ id: 'a', label: 'Alpha' }] },
  blocking: 'task',
  state: 'open',
  ...over,
})

const build = (
  task: { items: Item[]; rides: Ride[] },
  now = T('23:59:59'),
) => buildTimeline(task, now)

// Render each timeline entry as a short tag so order assertions stay readable:
// `user:p1` for a user bubble, `asst:r1` for a ride turn, `event:wedged`,
// `ask:ask-0` for a standalone (platform) ask.
const seq = (items: ReturnType<typeof buildTimeline>['items']) =>
  items.map((it) =>
    it.kind === 'event'
      ? `event:${it.event.eventKind}`
      : it.kind === 'user'
        ? `user:${it.item.id}`
        : it.kind === 'ask'
          ? `ask:${it.ask.id}`
      : it.kind === 'hook'
            ? `hook:${it.hook.id}`
            : it.kind === 'task-action'
              ? `action:${it.action.id}`
            : `asst:${it.ride.id}`,
  )

describe('buildTimeline ride grouping', () => {
  it('keeps a simple alternating conversation in order', () => {
    const items = [
      user('p1', T('10:00:00')),
      flow('r1a', 'r1', T('10:00:05')),
      user('p2', T('10:01:00')),
      flow('r2a', 'r2', T('10:01:05')),
    ]
    const rides = [ride('r1', T('10:00:05'), T('10:00:06')), ride('r2', T('10:01:05'), T('10:01:06'))]
    const { items: out } = build({ items, rides })
    expect(seq(out)).toEqual(['user:p1', 'asst:r1', 'user:p2', 'asst:r2'])
  })

  it('collapses a ride’s contiguous items (flow + tools) into one turn entry', () => {
    const items = [
      user('p1', T('10:00:00')),
      flow('r1a', 'r1', T('10:00:05')),
      tool('r1b', 'r1', T('10:00:06')),
      flow('r1c', 'r1', T('10:00:07')),
    ]
    const rides = [ride('r1', T('10:00:05'), T('10:00:08'))]
    const { items: out } = build({ items, rides })
    expect(seq(out)).toEqual(['user:p1', 'asst:r1'])
    const asst = out.find((e) => e.kind === 'ride')
    expect(asst?.kind === 'ride' && asst.items.map((i) => i.id)).toEqual([
      'r1a',
      'r1b',
      'r1c',
    ])
  })

  it('renders several batched prompts as distinct bubbles before one ride', () => {
    const items = [
      user('p1', T('10:00:00')),
      user('p2', T('10:00:01')),
      user('p3', T('10:00:02')),
      flow('r1a', 'r1', T('10:00:10')),
    ]
    const rides = [ride('r1', T('10:00:10'), T('10:00:11'))]
    const { items: out } = build({ items, rides })
    expect(seq(out)).toEqual(['user:p1', 'user:p2', 'user:p3', 'asst:r1'])
  })

  it('keeps a ride whole when an event splits its items, surfacing the event after the turn', () => {
    // `lander wedge` fires a `wedged` event mid-turn while the ride keeps writing
    // its final message — the turn must stay one bubble, the event after it.
    const items = [
      user('p1', T('10:00:00')),
      flow('r1a', 'r1', T('10:00:05')),
      ev('wedged', T('10:00:06')),
      flow('r1b', 'r1', T('10:00:07')),
    ]
    const rides = [ride('r1', T('10:00:05'), T('10:00:08'))]
    const { items: out } = build({ items, rides })
    expect(seq(out)).toEqual(['user:p1', 'asst:r1', 'event:wedged'])
    const asst = out.find((e) => e.kind === 'ride')
    expect(asst?.kind === 'ride' && asst.items.map((i) => i.id)).toEqual([
      'r1a',
      'r1b',
    ])
  })

  it('gives back-to-back rides their own turns', () => {
    const items = [flow('r0a', 'r0', T('09:00:00')), flow('r1a', 'r1', T('09:00:01'))]
    const rides = [ride('r0', T('09:00:00'), T('09:00:00')), ride('r1', T('09:00:01'), T('09:00:01'))]
    const { items: out } = build({ items, rides })
    expect(seq(out)).toEqual(['asst:r0', 'asst:r1'])
  })
})

describe('buildTimeline events in place', () => {
  it('renders events at their stored array position', () => {
    const items = [
      ev('launched', T('09:59:00')),
      user('p1', T('10:00:00')),
      flow('r1a', 'r1', T('10:00:05')),
      ev('landed', T('10:05:00')),
    ]
    const rides = [ride('r1', T('10:00:05'), T('10:00:06'))]
    const { items: out } = build({ items, rides })
    expect(seq(out)).toEqual(['event:launched', 'user:p1', 'asst:r1', 'event:landed'])
  })
})

describe('buildTimeline task actions on their turn', () => {
  const actionsOf = (out: ReturnType<typeof buildTimeline>['items']) => {
    const asst = out.find((e) => e.kind === 'ride')
    return asst?.kind === 'ride' ? asst.actions.map((a) => a.id) : undefined
  }

  it('hands an action to the turn that took it, taking no slot of its own', () => {
    const items = [
      user('p1', T('10:00:00')),
      flow('r1a', 'r1', T('10:00:05')),
      action('a1', T('10:00:06'), 'r1'),
      action('a2', T('10:00:07'), 'r1'),
      flow('r1b', 'r1', T('10:00:08')),
    ]
    const rides = [ride('r1', T('10:00:05'), T('10:00:09'))]
    const { items: out } = build({ items, rides })
    expect(seq(out)).toEqual(['user:p1', 'asst:r1'])
    // In record order — the turn decides where they land, not this.
    expect(actionsOf(out)).toEqual(['a1', 'a2'])
  })

  it('finds the turn for an action recorded before it had streamed anything', () => {
    // The CLI reaches the server while the turn's first batch is still in
    // flight, so the action is stored ahead of every item of its own ride.
    const items = [
      action('a1', T('10:00:00'), 'r1'),
      flow('r1a', 'r1', T('10:00:01')),
    ]
    const rides = [ride('r1', T('10:00:01'), T('10:00:02'))]
    const { items: out } = build({ items, rides })
    expect(seq(out)).toEqual(['asst:r1'])
    expect(actionsOf(out)).toEqual(['a1'])
  })

  it('leaves an action standing when its ride never reached the stream', () => {
    // A ride that streamed nothing gets no turn entry, so there is nothing to
    // anchor into and the note keeps the slot it was recorded in.
    const items = [user('p1', T('10:00:00')), action('a1', T('10:00:01'), 'r9')]
    const { items: out } = build({ items, rides: [ride('r9', T('10:00:00'))] })
    expect(seq(out)).toEqual(['user:p1', 'action:a1'])
  })
})

describe('buildTimeline task actions with no turn', () => {
  it('keeps a split ride whole and preserves action order after it', () => {
    const items = [
      user('p1', T('10:00:00')),
      flow('r1a', 'r1', T('10:00:05')),
      action('a1', T('10:00:06')),
      action('a2', T('10:00:07')),
      flow('r1b', 'r1', T('10:00:08')),
    ]
    const rides = [ride('r1', T('10:00:05'), T('10:00:09'))]
    const { items: out } = build({ items, rides })
    expect(seq(out)).toEqual([
      'user:p1',
      'asst:r1',
      'action:a1',
      'action:a2',
    ])
  })

  it('leaves an action before a ride when it was stored first', () => {
    const items = [
      action('a1', T('10:00:00')),
      flow('r1a', 'r1', T('10:00:01')),
    ]
    const rides = [ride('r1', T('10:00:01'), T('10:00:02'))]
    expect(seq(build({ items, rides }).items)).toEqual([
      'action:a1',
      'asst:r1',
    ])
  })
})

describe('buildTimeline queued follow-ups', () => {
  it('sinks a queued follow-up below the whole conversation, keeping later events above it', () => {
    const items = [
      user('p1', T('10:00:00')),
      flow('r1a', 'r1', T('10:00:05')),
      ev('landed', T('10:01:00')),
      user('p2', T('10:02:00'), true),
    ]
    const rides = [ride('r1', T('10:00:05'), T('10:00:06'))]
    const { items: out } = build({ items, rides })
    expect(seq(out)).toEqual(['user:p1', 'asst:r1', 'event:landed', 'user:p2'])
    const p2 = out.find((e) => e.kind === 'user' && e.item.id === 'p2')
    expect(p2?.kind === 'user' && p2.item.queued).toBe(true)
  })

  it('pulls a follow-up queued mid-ride out of the ride and down to the bottom', () => {
    // p_q was sent while r1 was still streaming, so it sits between r1's items in
    // array order; the sink lifts it out and the ride stays one contiguous turn.
    const items = [
      user('p1', T('10:00:00')),
      flow('r1a', 'r1', T('10:00:05')),
      user('pq', T('10:00:06'), true),
      tool('r1b', 'r1', T('10:00:07')),
    ]
    const rides = [ride('r1', T('10:00:05'))] // open ride
    const { items: out } = build({ items, rides })
    expect(seq(out)).toEqual(['user:p1', 'asst:r1', 'user:pq'])
    const asst = out.find((e) => e.kind === 'ride')
    expect(asst?.kind === 'ride' && asst.items.map((i) => i.id)).toEqual(['r1a', 'r1b'])
  })

  it('surfaces a deferred retry as scheduled-then-woken, with the un-wedge above the still-queued recovery prompt', () => {
    // A session-limit wedge whose retry was scheduled: the recovery prompt is
    // queued (appended at schedule time) but sinks below the un-wedge/launch
    // events that only fire at the wakeup — it reads as "un-wedged, then sent".
    const items = [
      user('p1', T('10:00:00')),
      flow('r1a', 'r1', T('10:00:05')),
      user('try-again', T('10:05:00'), true),
      ev('wedged', T('10:00:06')),
      ev('scheduled', T('10:05:00')),
      ev('unwedged', T('12:59:59')),
      ev('launched', T('13:00:00')),
    ]
    const rides = [ride('r1', T('10:00:05'), T('10:00:06'))]
    const { items: out } = build({ items, rides })
    expect(seq(out)).toEqual([
      'user:p1',
      'asst:r1',
      'event:wedged',
      'event:scheduled',
      'event:unwedged',
      'event:launched',
      'user:try-again',
    ])
  })
})

describe('buildTimeline in-flight anchoring', () => {
  it('anchors an open ride’s entry to `now`, and a settled one to its own timestamp', () => {
    const items = [
      flow('r0a', 'r0', T('10:00:00')),
      flow('r1a', 'r1', T('10:10:00')),
    ]
    const rides = [ride('r0', T('10:00:00'), T('10:00:01')), ride('r1', T('10:10:00'))]
    const { items: out } = build({ items, rides }, T('10:05:00'))
    const settled = out.find((e) => e.kind === 'ride' && e.ride.id === 'r0')
    const open = out.find((e) => e.kind === 'ride' && e.ride.id === 'r1')
    expect(settled?.at).toBe(T('10:00:00'))
    expect(open?.at).toBe(T('10:05:00'))
  })
})

// A platform ask (a kill, a daemon outage) has no message to anchor to, so it
// stands as its own entry — and stays there once settled, because its prompt is
// the conversation's record of what happened.
describe('buildTimeline ask placement', () => {
  it('gives an unanchored ask its own entry, in the position it was raised', () => {
    const items = [
      user('p1', T('10:00:00')),
      flow('r1a', 'r1', T('10:00:05')),
      ask('ask-0', T('10:00:10'), { prompt: 'This ride was killed.' }),
      user('p2', T('10:01:00')),
    ]
    const rides = [ride('r1', T('10:00:05'), T('10:00:06'))]
    expect(seq(build({ items, rides }).items)).toEqual([
      'user:p1',
      'asst:r1',
      'ask:ask-0',
      'user:p2',
    ])
  })

  it('keeps a settled ask that still carries a prompt, and drops one that does not', () => {
    const items = [
      // A settled platform ask: the prompt is the record, so it stays.
      ask('ask-kill', T('10:00:00'), {
        state: 'withdrawn',
        prompt: 'This ride was killed.',
      }),
      // Promptless and settled: no record to keep, no form to press.
      ask('ask-spent', T('10:01:00'), { state: 'answered' }),
      // Promptless but open: the form is still live, so it must render.
      ask('ask-live', T('10:02:00')),
    ]
    expect(seq(build({ items, rides: [] }).items)).toEqual([
      'ask:ask-kill',
      'ask:ask-live',
    ])
  })

  it('leaves an ask anchored to a rendered ride to the bubble that renders it', () => {
    const items = [
      flow('r1a', 'r1', T('10:00:00')),
      ask('ask-wedge', T('10:00:05'), { rideId: 'r1' }),
    ]
    const rides = [ride('r1', T('10:00:00'), T('10:00:06'))]
    expect(seq(build({ items, rides }).items)).toEqual(['asst:r1'])
  })

  it('stands an ask up on its own when its ride streamed nothing else', () => {
    const items = [
      flow('r1a', 'r1', T('10:00:00')),
      ask('ask-orphan', T('10:00:05'), { rideId: 'gone' }),
    ]
    const rides = [ride('r1', T('10:00:00'), T('10:00:06'))]
    expect(seq(build({ items, rides }).items)).toEqual(['asst:r1', 'ask:ask-orphan'])
  })
})
