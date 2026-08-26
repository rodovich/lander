import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ComponentProps } from 'react'
import { RideTurn } from './rideTurn'
import type { RideItem } from './timeline'
import type {
  AskItem,
  MessageItem,
  Ride,
  TaskActionItem,
  ToolItem,
} from './types'

// renderToStaticMarkup gives the initial (effect-free) markup, which is all a
// turn needs: nesting, grouping, folding, and the footers are all pure renders
// of the props — nothing here waits on a mounted effect.
const T = (clock: string) => `2026-06-26T${clock}.000Z`
const AT = T('10:00:00')

const flow = (
  id: string,
  text: string,
  over: Partial<MessageItem> = {},
): MessageItem => ({
  id,
  at: AT,
  rideId: 'r1',
  kind: 'message',
  role: 'flow',
  text,
  ...over,
})
const tool = (id: string, over: Partial<ToolItem> = {}): ToolItem => ({
  id,
  at: AT,
  rideId: 'r1',
  kind: 'tool',
  name: 'Bash',
  input: 'ls',
  status: 'ok',
  ...over,
})
const settledRide = (over: Partial<Ride> = {}): Ride => ({
  id: 'r1',
  startedAt: AT,
  endedAt: T('10:05:00'),
  outcome: 'done',
  ...over,
})
const openAsk = (over: Partial<AskItem> = {}): AskItem => ({
  id: 'k1',
  at: AT,
  kind: 'ask',
  form: { type: 'choice', options: [{ id: 'a', label: 'Alpha-option' }] },
  blocking: 'task',
  state: 'open',
  ...over,
})

const render = (
  items: RideItem[],
  over: Partial<ComponentProps<typeof RideTurn>> = {},
) =>
  renderToStaticMarkup(
    <RideTurn
      ride={settledRide()}
      items={items}
      actions={[]}
      agent="claude"
      taskId="task1"
      slug="proj"
      grants={undefined}
      linkTask={() => undefined}
      openDetails={new Set()}
      onToggleDetail={() => {}}
      expandedTurns={new Set()}
      onToggleTurn={() => {}}
      openAsk={undefined}
      answering={false}
      onAnswerAsk={() => {}}
      onAllow={async () => true}
      {...over}
    />,
  )

const count = (html: string, needle: string) =>
  html.split(needle).length - 1

describe('RideTurn subagent nesting', () => {
  const trace: RideItem[] = [
    tool('sp', { name: 'Agent', input: 'spawn a searcher' }),
    tool('child', { name: 'Read', input: 'read a file', parentId: 'sp' }),
    flow('reply', 'subagent-final-reply', { parentId: 'sp' }),
  ]

  it('folds subagent items under the spawning chip, out of the main thread', () => {
    const html = render(trace)
    // The spawner renders; its children stay behind the closed disclosure and
    // never open a main-thread group of their own.
    expect(html).toContain('Agent')
    expect(html).not.toContain('read a file')
    expect(html).not.toContain('subagent-final-reply')
    expect(count(html, 'class="inference"')).toBe(1)
  })

  it('reveals the nested trace when the spawner chip is open', () => {
    const html = render(trace, { openDetails: new Set(['sp']) })
    expect(html).toContain('sub-steps')
    expect(html).toContain('read a file')
    expect(html).toContain('subagent-final-reply')
  })
})

describe('RideTurn inference grouping', () => {
  it('rules groups apart exactly at groupId changes, keeping ungrouped items with the current group', () => {
    // g1, g1, (none — stays with g1), g2 → two inference groups, one rule.
    // Rendered open so the collapse planner stays out of the picture.
    const html = render(
      [
        flow('a', 'first-thought', { groupId: 'g1' }),
        tool('b', { groupId: 'g1' }),
        tool('c', {}),
        flow('d', 'second-thought', { groupId: 'g2' }),
      ],
      { ride: settledRide({ endedAt: undefined }) },
    )
    expect(count(html, 'class="inference"')).toBe(2)
    expect(count(html, 'turn-sep')).toBe(1)
  })
})

describe('RideTurn turn-collapse folding', () => {
  // Opening prose, then a middle stretch (tool, short prose, tool) that folds,
  // then the long closing prose: planTurnCollapse keeps the opening and the
  // longest/last sequence, hiding positions 1–3 as one segment (key "r1:1").
  const folding: RideItem[] = [
    flow('open', 'opening-prose', { groupId: 'g1' }),
    tool('t1', { groupId: 'g2' }),
    flow('mid', 'hidden-middle-prose', { groupId: 'g3' }),
    tool('t2', { groupId: 'g4' }),
    flow('end', 'closing-'.repeat(10), { groupId: 'g5' }),
  ]

  it('folds the middle behind a step/tool summary on a settled ride', () => {
    const html = render(folding)
    expect(html).toContain('opening-prose')
    expect(html).toContain('closing-')
    expect(html).not.toContain('hidden-middle-prose')
    // Three inference groups (g2, g3, g4) and two tools fold away.
    expect(html).toContain('3 steps, 2 tools')
  })

  it('expands a fold whose ride:segment key is in expandedTurns', () => {
    const html = render(folding, { expandedTurns: new Set(['r1:1']) })
    expect(html).toContain('hidden-middle-prose')
  })

  it('renders an open (unsettled) ride in full, with no fold', () => {
    const html = render(folding, { ride: settledRide({ endedAt: undefined }) })
    expect(html).toContain('hidden-middle-prose')
    expect(html).not.toContain('steps, 2 tools')
  })
})

describe('RideTurn cross-task actions', () => {
  const taskAction = (id: string, at: string): TaskActionItem => ({
    id,
    at,
    kind: 'task-action',
    ride: 'r1',
    action: 'launch',
    target: { id: 'child', projectSlug: 'proj', title: `child-of-${id}` },
  })

  it('leads the next inference, ruled off from it and with no timestamp', () => {
    const html = render(
      [
        flow('open', 'opening-prose', { at: T('10:00:01'), groupId: 'g1' }),
        tool('t1', { at: T('10:00:02'), groupId: 'g1' }),
        flow('end', 'closing-prose', { at: T('10:00:09'), groupId: 'g2' }),
      ],
      { actions: [taskAction('a1', T('10:00:03'))] },
    )
    expect(html).toContain('timeline-note in-turn')
    expect(html).toContain('child-of-a1')
    // Between the tool it followed and the paragraph it leads.
    expect(html.indexOf('child-of-a1')).toBeGreaterThan(html.indexOf('t1'))
    expect(html.indexOf('child-of-a1')).toBeLessThan(html.indexOf('closing-prose'))
    // Its own block above the inference, ruled apart from it — not a step
    // inside the group whose prose it precedes.
    expect(html).toMatch(
      /<div class="turn-notes">.*<\/div><hr class="turn-sep"\/><div class="inference">/,
    )
    // The turn already says when it ran; the moment stays as the row's title.
    expect(html).not.toContain('timeline-note-time')
  })

  it('renders against the item itself when its prose opens no inference', () => {
    // An inference that streamed a tool before its text, so the prose the note
    // anchors to isn't the group's opening item and there's no boundary to
    // lead. Nothing observed does this — the branch is here so a trace that
    // did would still put the note against the item it belongs to.
    const html = render(
      [
        tool('t1', { at: T('10:00:01'), groupId: 'g1' }),
        flow('end', 'closing-prose', { at: T('10:00:09'), groupId: 'g1' }),
      ],
      {
        actions: [taskAction('a1', T('10:00:03'))],
        ride: settledRide({ endedAt: undefined }),
      },
    )
    expect(count(html, 'class="inference"')).toBe(1)
    expect(html.indexOf('child-of-a1')).toBeGreaterThan(html.indexOf('t1'))
    expect(html.indexOf('child-of-a1')).toBeLessThan(html.indexOf('closing-prose'))
    // Inside the inference, against its prose — not hoisted above the group.
    expect(html).not.toMatch(/turn-notes.*<hr class="turn-sep"\/><div class="inference">/)
  })

  it('surfaces below a folded stretch rather than inside it', () => {
    const folding: RideItem[] = [
      flow('open', 'opening-prose', { at: T('10:00:01'), groupId: 'g1' }),
      tool('t1', { at: T('10:00:02'), groupId: 'g2' }),
      flow('mid', 'hidden-middle-prose', { at: T('10:00:04'), groupId: 'g3' }),
      tool('t2', { at: T('10:00:05'), groupId: 'g4' }),
      flow('end', 'closing-'.repeat(10), { at: T('10:00:09'), groupId: 'g5' }),
    ]
    // Taken during the stretch that folds away — its `lander launch` chip is
    // behind the summary, but the note is not.
    const html = render(folding, { actions: [taskAction('a1', T('10:00:03'))] })
    expect(html).toContain('3 steps, 2 tools')
    expect(html).not.toContain('hidden-middle-prose')
    expect(html).toContain('child-of-a1')
    expect(html.indexOf('child-of-a1')).toBeGreaterThan(html.indexOf('3 steps'))
  })

  it('stacks everything done in one stretch as a single block', () => {
    const html = render(
      [
        tool('t1', { at: T('10:00:01') }),
        flow('end', 'closing-prose', { at: T('10:00:09') }),
      ],
      {
        actions: [
          taskAction('a1', T('10:00:02')),
          taskAction('a2', T('10:00:03')),
        ],
      },
    )
    expect(count(html, 'turn-notes')).toBe(1)
    expect(html.indexOf('child-of-a1')).toBeLessThan(html.indexOf('child-of-a2'))
  })

  it('closes out the trace when no prose follows the action', () => {
    const html = render(
      [
        flow('open', 'opening-prose', { at: T('10:00:01') }),
        tool('t1', { at: T('10:00:02') }),
      ],
      {
        actions: [taskAction('a1', T('10:00:03'))],
        ride: settledRide({ endedAt: undefined }),
      },
    )
    expect(html.indexOf('child-of-a1')).toBeGreaterThan(
      html.indexOf('opening-prose'),
    )
    // Ruled off from the trace it closes, like a lead block.
    expect(html).toMatch(/<hr class="turn-sep"\/><div class="turn-notes">/)
    // Inside the trace, so a still-working turn reads "…launched X" and then
    // goes on working, rather than announcing it after the spinner.
    expect(html.indexOf('child-of-a1')).toBeLessThan(html.indexOf('is working…'))
  })
})

describe('RideTurn settled/open footers', () => {
  it('shows the working spinner only while the ride is open, never a blocked summary', () => {
    const html = render(
      [tool('t1', { status: 'blocked', rule: 'Bash(rm:*)' })],
      { ride: settledRide({ endedAt: undefined }) },
    )
    expect(html).toContain('is working…')
    expect(html).not.toContain('blocked-summary')
  })

  it('shows the blocked summary only once the ride settles, and no spinner', () => {
    const html = render([tool('t1', { status: 'blocked', rule: 'Bash(rm:*)' })])
    expect(html).toContain('blocked-summary')
    expect(html).not.toContain('is working…')
  })

  it('gathers the flow items’ artifacts below the turn', () => {
    const html = render([
      flow('a', 'done', {
        artifacts: [
          {
            name: 'report.md',
            id: 'art1',
            mime: 'text/markdown',
            size: 10,
            createdAt: AT,
            updatedAt: AT,
          },
        ],
      }),
    ])
    expect(html).toContain('message-attachments')
    expect(html).toContain('report.md')
  })
})

describe('RideTurn open-ask footer', () => {
  it('renders the open ask as the footer of the ride that raised it', () => {
    const html = render([flow('f1', 'shall I?')], {
      openAsk: openAsk({ rideId: 'r1' }),
    })
    expect(html).toContain('Alpha-option')
  })

  it('leaves the ask out when another ride raised it', () => {
    const html = render([flow('f1', 'shall I?')], {
      openAsk: openAsk({ rideId: 'elsewhere' }),
    })
    expect(html).not.toContain('Alpha-option')
  })
})
