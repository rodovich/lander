import { describe, expect, it } from 'vitest'
import { conversationMarkdown } from './conversationMarkdown'
import { buildTimeline } from './timeline'
import type {
  EventItem,
  Item,
  MessageItem,
  Ride,
  TaskActionItem,
  TaskWithProject,
  ToolItem,
} from './types'

const AT = '2026-06-26T10:00:00.000Z'

const user = (id: string, text: string, over: Partial<MessageItem> = {}): MessageItem => ({
  id,
  at: AT,
  kind: 'message',
  role: 'user',
  text,
  ...over,
})
const flow = (
  id: string,
  rideId: string,
  text: string,
  groupId?: string,
): MessageItem => ({
  id,
  at: AT,
  rideId,
  groupId,
  kind: 'message',
  role: 'flow',
  text,
})
const tool = (id: string, rideId: string, over: Partial<ToolItem> = {}): ToolItem => ({
  id,
  at: AT,
  rideId,
  kind: 'tool',
  name: 'Bash',
  input: 'git status',
  status: 'ok',
  ...over,
})

const task = (items: Item[], rides: Ride[]): TaskWithProject => ({
  id: 'task1',
  title: 'Fix the parser',
  status: 'pacing',
  createdAt: AT,
  allowEdits: true,
  projectSlug: 'proj',
  items,
  rides,
})

const md = (
  t: TaskWithProject,
  state: { openDetails?: string[]; expandedTurns?: string[] } = {},
) =>
  conversationMarkdown({
    task: t,
    timeline: buildTimeline(t, AT).items,
    openDetails: new Set(state.openDetails ?? []),
    expandedTurns: new Set(state.expandedTurns ?? []),
  })

describe('conversationMarkdown', () => {
  it('writes the title, the user bubbles, and each turn as a heading', () => {
    const out = md(
      task(
        [user('m1', 'do the thing'), flow('m2', 'r1', 'did the thing')],
        [{ id: 'r1', startedAt: AT, endedAt: AT }],
      ),
    )
    expect(out).toContain('# Fix the parser')
    expect(out).toMatch(/## user · .*\n\ndo the thing/)
    expect(out).toMatch(/## assistant · .*\n\ndid the thing/)
  })

  it('gives a closed tool chip its one-line input and nothing more', () => {
    const out = md(
      task(
        [
          tool('t1', 'r1', {
            inputFull: 'git status\ngit diff',
            output: 'nothing to commit',
          }),
        ],
        [{ id: 'r1', startedAt: AT, endedAt: AT }],
      ),
    )
    expect(out).toContain('**Bash** `git status`')
    expect(out).not.toContain('git diff')
    expect(out).not.toContain('nothing to commit')
  })

  it('unfolds an open tool chip into its full input and captured output', () => {
    const out = md(
      task(
        [
          tool('t1', 'r1', {
            inputFull: 'git status\ngit diff',
            output: 'nothing to commit',
          }),
        ],
        [{ id: 'r1', startedAt: AT, endedAt: AT }],
      ),
      { openDetails: ['t1'] },
    )
    expect(out).toContain('```\ngit status\ngit diff\n```')
    expect(out).toContain('```\nnothing to commit\n```')
    // The one-line copy moved into the body, as it does on the chip.
    expect(out).not.toContain('**Bash** `git status`')
  })

  it('writes an open edit as a diff and marks a blocked call', () => {
    const out = md(
      task(
        [
          tool('t1', 'r1', {
            name: 'Edit',
            input: 'src/a.ts',
            status: 'blocked',
            edits: [{ old: 'before\n', new: 'after\n' }],
          }),
        ],
        [{ id: 'r1', startedAt: AT, endedAt: AT }],
      ),
      { openDetails: ['t1'] },
    )
    expect(out).toContain('```diff\n- before\n+ after\n```')
    expect(out).toContain('_(blocked)_')
  })

  it('nests a subagent trace under its spawner only once opened', () => {
    const items: Item[] = [
      tool('t1', 'r1', { name: 'Agent', input: 'explore' }),
      flow('s1', 'r1', 'found it'),
    ]
    ;(items[1] as MessageItem).parentId = 't1'
    const t = task(items, [{ id: 'r1', startedAt: AT, endedAt: AT }])
    expect(md(t)).not.toContain('found it')
    expect(md(t, { openDetails: ['t1'] })).toContain('> found it')
  })

  it('stands a folded stretch down to the summary the fold shows', () => {
    // Three inference groups fall inside the fold, so it summarizes as three
    // steps and the two tool calls among them.
    const items: Item[] = [
      flow('m1', 'r1', 'opening', 'g1'),
      tool('t1', 'r1', { groupId: 'g1' }),
      flow('m2', 'r1', 'a middle note', 'g2'),
      tool('t2', 'r1', { groupId: 'g3' }),
      flow('m3', 'r1', 'the longest message of the whole turn by far', 'g4'),
      flow('m4', 'r1', 'wrapping up', 'g5'),
    ]
    const t = task(items, [{ id: 'r1', startedAt: AT, endedAt: AT }])
    const folded = md(t)
    expect(folded).not.toContain('a middle note')
    expect(folded).toContain('_3 steps, 2 tools…_')
    expect(folded).toContain('opening')
    expect(folded).toContain('wrapping up')
    // The reader expanded that stretch, so the copy carries it.
    const opened = md(t, { expandedTurns: ['r1:1'] })
    expect(opened).toContain('a middle note')
    expect(opened).not.toContain('steps, 2 tools…')
  })

  it('keeps an open turn whole — an unsettled ride never folds', () => {
    const items: Item[] = [
      flow('m1', 'r1', 'opening'),
      tool('t1', 'r1'),
      flow('m2', 'r1', 'a middle note'),
      tool('t2', 'r1'),
      flow('m3', 'r1', 'the longest message of the whole turn by far'),
      tool('t3', 'r1'),
      flow('m4', 'r1', 'wrapping up'),
    ]
    expect(md(task(items, [{ id: 'r1', startedAt: AT }]))).toContain(
      'a middle note',
    )
  })

  it('words lifecycle events and cross-task actions as the timeline does', () => {
    const event: EventItem = {
      id: 'e1',
      at: AT,
      kind: 'event',
      eventKind: 'wedged',
      title: 'Fix the parser',
    }
    const action: TaskActionItem = {
      id: 'a1',
      at: AT,
      kind: 'task-action',
      action: 'launch',
      target: { id: 'child', projectSlug: 'proj', title: 'Child task' },
    }
    const out = md(task([event, action], []))
    expect(out).toContain('_Fix the parser wedged_')
    expect(out).toContain('_launched task Child task_')
  })

  it('carries an open ask as the footer of the turn that raised it', () => {
    const out = md(
      task(
        [
          flow('m1', 'r1', 'I need a call here'),
          {
            id: 'ask1',
            at: AT,
            rideId: 'r1',
            kind: 'ask',
            prompt: 'which way?',
            form: { type: 'choice', options: [{ id: 'a', label: 'Alpha' }] },
            blocking: 'task',
            state: 'open',
          },
        ],
        [{ id: 'r1', startedAt: AT }],
      ),
    )
    expect(out).toContain('which way?')
    expect(out).toContain('- Alpha')
  })

  it('fences content that carries backticks without letting it break out', () => {
    const out = md(
      task(
        [tool('t1', 'r1', { input: 'echo `date`', output: 'a ``` fence' })],
        [{ id: 'r1', startedAt: AT, endedAt: AT }],
      ),
      { openDetails: ['t1'] },
    )
    expect(out).toContain('```\necho `date`\n```')
    expect(out).toContain('````\na ``` fence\n````')
  })
})
