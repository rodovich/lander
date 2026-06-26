import { describe, it, expect } from 'vitest'
import { buildTimeline } from './timeline'

// Minimal message/event shapes that satisfy buildTimeline's structural
// constraints; `id`/`kind` are just labels the assertions read back.
type M = { role: 'user' | 'assistant'; createdAt: string; id: string }
type E = { kind: string; createdAt: string }

const u = (id: string, createdAt: string): M => ({ role: 'user', createdAt, id })
const a = (id: string, createdAt: string): M => ({
  role: 'assistant',
  createdAt,
  id,
})
const ev = (kind: string, createdAt: string): E => ({ kind, createdAt })

// Pick clearly-ordered ISO timestamps without hand-writing the date each time.
const T = (clock: string) => `2026-06-26T${clock}.000Z`

// Render each timeline item as a short tag so order assertions stay readable:
// `user:q1` / `asst:r1` for messages, `event:wedged` for lifecycle events.
const seq = (items: ReturnType<typeof buildTimeline<M, E>>['items']) =>
  items.map((it) =>
    it.kind === 'event'
      ? `event:${it.event.kind}`
      : `${it.message.role === 'assistant' ? 'asst' : 'user'}:${it.message.id}`,
  )

const build = (
  task: { messages: M[]; events?: E[]; queued?: string[] },
  now = T('23:59:59'),
) => buildTimeline<M, E>(task, now)

describe('buildTimeline turn grouping', () => {
  it('keeps a simple alternating conversation in message order', () => {
    const messages = [
      u('p1', T('10:00:00')),
      a('r1', T('10:00:05')),
      u('p2', T('10:01:00')),
      a('r2', T('10:01:05')),
    ]
    const { items } = build({ messages })
    expect(seq(items)).toEqual(['user:p1', 'asst:r1', 'user:p2', 'asst:r2'])
    expect(items.map((it) => it.kind === 'message' && it.index)).toEqual([
      0, 1, 2, 3,
    ])
  })

  it('renders several batched prompts as distinct bubbles under one reply', () => {
    // Follow-ups queued while the agent ran are sent as one turn, but each stays
    // its own rendered message — several users under a single assistant reply.
    const messages = [
      u('p1', T('10:00:00')),
      u('p2', T('10:00:01')),
      u('p3', T('10:00:02')),
      a('r1', T('10:00:10')),
    ]
    const { items } = build({ messages })
    expect(seq(items)).toEqual(['user:p1', 'user:p2', 'user:p3', 'asst:r1'])
  })

  it('gives a doubled/leading assistant its own turn', () => {
    const messages = [a('r0', T('09:00:00')), a('r1', T('09:00:01'))]
    const { items } = build({ messages })
    expect(seq(items)).toEqual(['asst:r0', 'asst:r1'])
  })
})

describe('buildTimeline read-time anchoring', () => {
  it('does not sort by createdAt: a follow-up answered later stays after the reply it waited on', () => {
    // p2 was queued *during* turn 1, so its enqueue time (10:00:02) is earlier
    // than turn 1's reply (10:00:30). Sorting by createdAt would float p2 above
    // r1; turn grouping keeps it in the turn that actually answered it.
    const messages = [
      u('p1', T('10:00:00')),
      a('r1', T('10:00:30')),
      u('p2', T('10:00:02')),
      a('r2', T('10:01:00')),
    ]
    const { items } = build({ messages })
    expect(seq(items)).toEqual(['user:p1', 'asst:r1', 'user:p2', 'asst:r2'])
  })
})

describe('buildTimeline event splicing', () => {
  it('surfaces an event just before the first message it predates, and a trailing event last', () => {
    const messages = [u('p1', T('10:00:00')), a('r1', T('10:00:05'))]
    const events = [ev('launched', T('09:59:00')), ev('landed', T('10:05:00'))]
    const { items } = build({ messages, events })
    expect(seq(items)).toEqual([
      'event:launched',
      'user:p1',
      'asst:r1',
      'event:landed',
    ])
  })

  it('sorts events by timestamp before splicing, regardless of input order', () => {
    const messages = [u('p1', T('10:00:00')), a('r1', T('10:00:05'))]
    // Deliberately out of order on input.
    const events = [ev('landed', T('10:05:00')), ev('launched', T('09:59:00'))]
    const { items } = build({ messages, events })
    expect(seq(items)).toEqual([
      'event:launched',
      'user:p1',
      'asst:r1',
      'event:landed',
    ])
  })
})

describe('buildTimeline queued follow-ups', () => {
  it('sinks queued messages below the whole conversation, with events that arrived meanwhile above them', () => {
    // p2 is still queued (one entry in `queued`). An event landed while it waited
    // — that event must render above the queued prompt, which sinks to the bottom.
    const messages = [
      u('p1', T('10:00:00')),
      a('r1', T('10:00:05')),
      u('p2', T('10:02:00')),
    ]
    const events = [ev('landed', T('10:01:00'))]
    const { items, queuedIndices } = build({
      messages,
      events,
      queued: ['p2 text'],
    })
    expect(seq(items)).toEqual([
      'user:p1',
      'asst:r1',
      'event:landed',
      'user:p2',
    ])
    expect([...queuedIndices]).toEqual([2])
  })

  it('reports the trailing N user messages as queued', () => {
    const messages = [
      u('p1', T('10:00:00')),
      a('r1', T('10:00:05')),
      u('p2', T('10:02:00')),
      u('p3', T('10:02:01')),
    ]
    const { queuedIndices } = build({ messages, queued: ['p2', 'p3'] })
    expect([...queuedIndices].sort((x, y) => x - y)).toEqual([2, 3])
  })
})

describe('buildTimeline in-flight turn anchoring', () => {
  it('anchors a live, unanswered turn to `now` so it stays below already-past events', () => {
    // p2 has been read and is in flight (no reply yet, not queued). A landed
    // event at 10:01 is in the past relative to `now` (10:05), so it sits above
    // the live turn even though p2's own createdAt (10:10) is later than both.
    const messages = [
      u('p1', T('10:00:00')),
      a('r1', T('10:00:05')),
      u('p2', T('10:10:00')),
    ]
    const events = [ev('landed', T('10:01:00'))]
    const { items } = build({ messages, events }, T('10:05:00'))
    expect(seq(items)).toEqual([
      'user:p1',
      'asst:r1',
      'event:landed',
      'user:p2',
    ])
  })
})
