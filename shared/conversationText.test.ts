import { describe, expect, it } from 'vitest'
import type { Item, Ride } from '../src/types'
import { conversationText } from './conversationText'

const AT = '2026-10-14T12:00:00.000Z'

const msg = (id: string, text: string, extra: Record<string, unknown> = {}): Item =>
  ({ id, at: AT, kind: 'message', role: 'user', text, ...extra }) as Item
const flow = (id: string, rideId: string, text: string, extra: Record<string, unknown> = {}): Item =>
  ({ id, at: AT, kind: 'message', role: 'flow', rideId, groupId: id, text, ...extra }) as Item
const tool = (id: string, rideId: string, name: string, input: string, extra: Record<string, unknown> = {}): Item =>
  ({ id, at: AT, kind: 'tool', rideId, groupId: id, name, input, status: 'ok', ...extra }) as Item

// The middle stretch is what the fold hides; one of its tools spawns a subagent.
const turn = (rideId: string): Item[] => [
  flow(`${rideId}-a`, rideId, 'Starting.'),
  tool(`${rideId}-t1`, rideId, 'Bash', 'ls\n-la'),
  flow(`${rideId}-b`, rideId, 'Halfway.'),
  tool(`${rideId}-t2`, rideId, 'Agent', 'review the diff'),
  flow(`${rideId}-sub`, rideId, 'Subagent verdict.', { parentId: `${rideId}-t2` }),
  flow(`${rideId}-c`, rideId, 'All done: the final report, longer than every other line.'),
]

const ride = (id: string, ended = true): Ride =>
  ({ id, startedAt: AT, ...(ended ? { endedAt: AT, outcome: 'done' } : {}) }) as Ride

describe('conversationText', () => {
  it('preserves context markers in a folded turn and reports only supplied metadata', () => {
    const items = turn('r1')
    items.splice(3, 0, {
      id: 'compact', at: AT, rideId: 'r1', kind: 'context', action: 'compaction',
      trigger: 'auto', beforeTokens: 182000, afterTokens: 24000, durationMs: 1250,
    })
    items.push({ id: 'checkpoint', at: AT, rideId: 'r1', kind: 'context', action: 'checkpoint' })
    const [agent] = conversationText({ items, rides: [ride('r1')] }, { expand: false })
    expect(agent.text).toContain('Context compacted · automatic · 182,000 → 24,000 tokens · 1.25 seconds')
    expect(agent.text).toContain('Context checkpoint created')
    expect(agent.text).not.toContain('Halfway.')
  })
  it('folds a turn the way the UI does, leaving out the subagent’s words', () => {
    const blocks = conversationText(
      { items: [msg('u1', 'Go.'), ...turn('r1')], rides: [ride('r1')] },
      { expand: false },
    )
    expect(blocks).toEqual([
      { role: 'user', text: 'Go.' },
      {
        role: 'assistant',
        text: 'Starting.\n\n[3 steps, 2 tools…]\n\nAll done: the final report, longer than every other line.',
        folded: true,
      },
    ])
  })

  it('opens every fold when expanded, still without the subagent’s words', () => {
    const [, agent] = conversationText(
      { items: [msg('u1', 'Go.'), ...turn('r1')], rides: [ride('r1')] },
      { expand: true },
    )
    expect(agent).toEqual({
      role: 'assistant',
      text:
        'Starting.\n\n⚙ Bash: ls -la\n\nHalfway.\n\n⚙ Agent: review the diff\n\n' +
        'All done: the final report, longer than every other line.',
    })
  })

  it('folds a turn that is still running', () => {
    const [agent] = conversationText(
      { items: turn('r1'), rides: [ride('r1', false)] },
      { expand: false },
    )
    expect(agent.folded).toBe(true)
  })

  it('names each received message by who sent it, in full', () => {
    const long = 'x'.repeat(5000)
    const blocks = conversationText(
      {
        items: [
          msg('u1', long, { from: { task: 'parent-1', via: 'launch' } }),
          msg('u2', 'Current date: 10/14/2026, 8:00:00 AM', { from: { lander: 'time' } }),
          { id: 'e1', at: AT, kind: 'event', eventKind: 'notified', title: 'T', message: 'u2' } as Item,
          { id: 'e2', at: AT, kind: 'event', eventKind: 'wedged', title: 'T' } as Item,
        ],
        rides: [],
      },
      { expand: false },
    )
    expect(blocks).toEqual([
      { role: 'from parent-1', text: long },
      { role: 'notification', text: 'Current date: 10/14/2026, 8:00:00 AM' },
    ])
  })

  it('leaves out a turn with nothing to show', () => {
    expect(
      conversationText(
        { items: [msg('u1', 'Go.'), flow('r1-a', 'r1', '')], rides: [ride('r1', false)] },
        { expand: false },
      ),
    ).toEqual([{ role: 'user', text: 'Go.' }])
  })
})
