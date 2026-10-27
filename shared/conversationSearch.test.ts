import { describe, expect, it } from 'vitest'
import { conversationIndex, countMatches, listMatches } from './conversationSearch'
import type { Item, Ride } from '../src/types'

const AT = '2026-09-30T10:00:00.000Z'

const user = (id: string, text: string): Item => ({
  id,
  at: AT,
  kind: 'message',
  role: 'user',
  text,
})
const flow = (id: string, text: string, rideId = 'r1'): Item => ({
  id,
  at: AT,
  rideId,
  kind: 'message',
  role: 'flow',
  text,
})
const tool = (
  id: string,
  over: { input?: string; output?: string; parentId?: string } = {},
): Item => ({
  id,
  at: AT,
  rideId: 'r1',
  kind: 'tool',
  name: 'Bash',
  input: over.input ?? 'ls',
  status: 'ok',
  ...(over.output ? { output: over.output } : {}),
  ...(over.parentId ? { parentId: over.parentId } : {}),
})

const task = (
  items: Item[],
  rides: Ride[] = [{ id: 'r1', startedAt: AT, endedAt: AT }],
) => ({ items, rides })

const count = (t: ReturnType<typeof task>, query: string) =>
  countMatches(conversationIndex(t), query)

const list = (t: ReturnType<typeof task>, query: string, limit: number) =>
  listMatches(conversationIndex(t), query, limit)

// A turn that folds: the opening, the longest sequence, and the last stay —
// with the tools trailing the last — and the middle note and the tools around
// it fold away.
const folding = (over: { input?: string } = {}) => [
  user('u1', 'go'),
  flow('m1', 'opening words'),
  tool('t1', { input: over.input, output: 'captured output text' }),
  flow('m2', 'a middle note'),
  tool('t2'),
  flow('m3', 'the longest message of the whole turn by far'),
  tool('t3'),
  flow('m4', 'closing words'),
  tool('t4', { input: 'kept chip input', output: 'kept chip output' }),
]

describe('conversation search', () => {
  it('matches every user message and the prose a collapsed turn keeps', () => {
    const t = task([...folding(), user('u2', 'a Later Reply')])
    for (const q of ['go', 'opening', 'longest message', 'closing', 'later reply'])
      expect(count(t, q)).toBe(1)
  })

  it('skips what the collapse folds away, and every tool call', () => {
    const t = task(folding({ input: 'folded chip input' }))
    for (const q of [
      'middle note',
      'folded chip input',
      'captured output',
      'kept chip input',
      'kept chip output',
      'bash',
    ])
      expect(count(t, q)).toBe(0)
  })

  it('matches a message an event delivered, though it renders folded', () => {
    const t = task([
      { id: 'e1', at: AT, kind: 'event', eventKind: 'relaunched', message: 'b1' },
      user('b1', 'the relaunch brief'),
    ])
    expect(list(t, 'relaunch brief', 5).map((m) => m.itemId)).toEqual(['b1'])
  })

  it('skips a subagent trace, which nests under its closed chip', () => {
    const t = task([
      user('u1', 'go'),
      tool('agent', { input: 'explore' }),
      { ...flow('s1', 'subagent findings'), parentId: 'agent' } as Item,
      flow('m1', 'done'),
    ])
    expect(count(t, 'subagent findings')).toBe(0)
  })

  it('collapses a running turn too', () => {
    const t = task(folding(), [{ id: 'r1', startedAt: AT }])
    expect(count(t, 'middle note')).toBe(0)
    expect(count(t, 'closing words')).toBe(1)
  })

  it('matches nothing for an empty query', () => {
    const t = task([user('u1', 'anything')])
    expect(count(t, '')).toBe(0)
    expect(list(t, '', 5)).toEqual([])
  })
})

describe('conversation match listing', () => {
  it('counts every match and lists them in order, by item and occurrence', () => {
    const t = task([
      user('u1', 'fix it, then fix it again'),
      ...folding(),
      user('u2', 'one more fix'),
    ])
    expect(count(t, 'fix')).toBe(3)
    expect(
      list(t, 'fix', 10).map(({ itemId, occurrence }) => [itemId, occurrence]),
    ).toEqual([
      ['u1', 0],
      ['u1', 1],
      ['u2', 0],
    ])
    expect(list(t, 'fix', 2)).toHaveLength(2)
  })

  it('excerpts the original text on one line, from a word boundary', () => {
    const lead = 'words '.repeat(10)
    const t = task([user('u1', `${lead}the\nPermissioning step`)])
    const [match] = list(t, 'permission', 1)
    // Cut at a space, not mid-word, and the newline collapsed.
    expect(match.snippet).toMatch(/^…words /)
    expect(match.snippet).toContain('the Permissioning step')
  })

  it('starts the excerpt without an ellipsis when the match is near the start', () => {
    const t = task([user('u1', 'needs permission first')])
    expect(list(t, 'permission', 1)[0].snippet).toBe('needs permission first')
  })
})
