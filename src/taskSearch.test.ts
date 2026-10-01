import { describe, expect, it } from 'vitest'
import { conversationMatches } from './taskSearch'
import type { Item, Ride, TaskWithProject } from './types'

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
  id: string,
  items: Item[],
  rides: Ride[] = [{ id: 'r1', startedAt: AT, endedAt: AT }],
): TaskWithProject => ({
  id,
  agent: 'claude',
  title: 'Untitled',
  status: 'paced',
  createdAt: AT,
  allowEdits: true,
  projectSlug: 'proj',
  items,
  rides,
})

const ids = (tasks: TaskWithProject[], query: string) =>
  [...conversationMatches(tasks, query).keys()].map((t) => t.id)

const matchesOf = (t: TaskWithProject, query: string) =>
  conversationMatches([t], query).get(t)

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

describe('conversationMatches', () => {
  it('matches every user message and the prose a collapsed turn keeps', () => {
    const t = task('a', [...folding(), user('u2', 'a Later Reply')])
    for (const q of ['go', 'opening', 'longest message', 'closing', 'later reply'])
      expect(ids([t], q)).toEqual(['a'])
  })

  it('skips what the collapse folds away, and every tool call', () => {
    const t = task('a', folding({ input: 'folded chip input' }))
    for (const q of [
      'middle note',
      'folded chip input',
      'captured output',
      'kept chip input',
      'kept chip output',
      'bash',
    ])
      expect(ids([t], q)).toEqual([])
  })

  it('skips a subagent trace, which nests under its closed chip', () => {
    const t = task('a', [
      user('u1', 'go'),
      tool('agent', { input: 'explore' }),
      { ...flow('s1', 'subagent findings'), parentId: 'agent' } as Item,
      flow('m1', 'done'),
    ])
    expect(ids([t], 'subagent findings')).toEqual([])
  })

  it('collapses a running turn too', () => {
    const t = task('a', folding(), [{ id: 'r1', startedAt: AT }])
    expect(ids([t], 'middle note')).toEqual([])
    expect(ids([t], 'closing words')).toEqual(['a'])
  })

  it('rereads a settled task once it gains an item', () => {
    const before = task('a', [user('u1', 'go')])
    expect(ids([before], 'second thought')).toEqual([])
    const after = task('a', [user('u1', 'go'), user('u2', 'second thought')])
    expect(ids([after], 'second thought')).toEqual(['a'])
  })

  it('rereads a running task every time, as its items change in place', () => {
    const running: Ride[] = [{ id: 'r1', startedAt: AT }]
    expect(ids([task('a', [flow('m1', 'draft')], running)], 'final')).toEqual([])
    // Same item count, text grown in place.
    expect(
      ids([task('a', [flow('m1', 'draft, now final')], running)], 'final'),
    ).toEqual(['a'])
  })
})

describe('conversation match listing', () => {
  it('counts every match and lists them in order, by item and occurrence', () => {
    const t = task('a', [
      user('u1', 'fix it, then fix it again'),
      ...folding(),
      user('u2', 'one more fix'),
    ])
    const m = matchesOf(t, 'fix')!
    expect(m.count).toBe(3)
    expect(
      m.list(10).map(({ itemId, occurrence }) => [itemId, occurrence]),
    ).toEqual([
      ['u1', 0],
      ['u1', 1],
      ['u2', 0],
    ])
    expect(m.list(2)).toHaveLength(2)
  })

  it('excerpts the original text on one line, from a word boundary', () => {
    const lead = 'words '.repeat(10)
    const t = task('a', [user('u1', `${lead}the\nPermissioning step`)])
    const [match] = matchesOf(t, 'permission')!.list(1)
    // Cut at a space, not mid-word, and the newline collapsed.
    expect(match.snippet).toMatch(/^…words /)
    expect(match.snippet).toContain('the Permissioning step')
  })

  it('starts the excerpt without an ellipsis when the match is near the start', () => {
    const t = task('b', [user('u1', 'needs permission first')])
    expect(matchesOf(t, 'permission')!.list(1)[0].snippet).toBe(
      'needs permission first',
    )
  })
})
