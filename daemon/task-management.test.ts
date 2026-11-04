// The task prompt template carries an {{id}} slot so the agent is told its own
// task id up front — an agent that knows its id won't mistake its own row in
// `lander list` for a separate "sibling" task (see task DrNwYlXD7L). These lock
// the substitution and guard against a leftover placeholder reaching the child.

import { describe, expect, it } from 'vitest'
import { buildRevivedBlock, buildScheduledRideBlock } from './flows/ctx'
import {
  deliveryDigest,
  fillTaskPrompt,
  prepareUserMessagePrompt,
} from './task-management'

const TEMPLATE = 'You are running inside a lander task. This task id is {{id}}.'

describe('fillTaskPrompt', () => {
  it('substitutes {{id}} and leaves no placeholder', () => {
    const out = fillTaskPrompt(TEMPLATE, 'abc123')
    expect(out).toContain('This task id is abc123.')
    expect(out).not.toContain('{{')
  })
})

// The wording is deliberate and deliberately minimal — it states what happened
// and stops. The one exception is the cleared-timer clause, which does point at
// `lander ride`: there the agent has lost something it may want back, and naming
// the remedy is the difference between a notice and a usable one. Asserted
// byte-for-byte so a later "helpful" embellishment has to be a decision.
describe('buildRevivedBlock', () => {
  it('renders the wedged notice', () => {
    expect(buildRevivedBlock({ from: 'wedged' })).toBe(
      '<task-revived>\n' +
        'You were wedged when this message arrived; the message changed your status to riding.\n' +
        '</task-revived>',
    )
  })

  it('renders the landed notice with the same one sentence', () => {
    expect(buildRevivedBlock({ from: 'landed' })).toBe(
      '<task-revived>\n' +
        'You were landed when this message arrived; the message changed your status to riding.\n' +
        '</task-revived>',
    )
  })

  // The common shape of the cleared-ride case: nothing notable was crossed, so
  // "waiting" is all there is to say about it.
  it('names a cleared scheduled ride, its time, and the way to schedule it again', () => {
    expect(buildRevivedBlock({ waitingUntil: '8/7/2026, 3:00:00 PM' })).toBe(
      '<task-revived>\n' +
        'You were waiting until 8/7/2026, 3:00:00 PM when this message arrived; ' +
        'the message changed your status to riding and cleared the ride you had ' +
        'scheduled for then. Schedule it again with `lander ride` if you still want it.\n' +
        '</task-revived>',
    )
  })

  // Both halves at once — a wedged task holding a deferred session-limit retry
  // ride, revived by a message. One sentence, not two notices.
  it('folds a crossed status and a cleared ride into one sentence', () => {
    expect(
      buildRevivedBlock({ from: 'wedged', waitingUntil: '3:00:00 PM' }),
    ).toBe(
      '<task-revived>\n' +
        'You were wedged until 3:00:00 PM when this message arrived; ' +
        'the message changed your status to riding and cleared the ride you had ' +
        'scheduled for then. Schedule it again with `lander ride` if you still want it.\n' +
        '</task-revived>',
    )
  })
})

describe('buildScheduledRideBlock', () => {
  const sentence = (when: string) =>
    '<ride-scheduled>\n' +
    `You have a ride scheduled ${when}. It stays scheduled unless you clear it ` +
    'with `lander ride --clear`; scheduling another with `lander ride` replaces it.\n' +
    '</ride-scheduled>'

  it('names the time of a time trigger', () => {
    expect(buildScheduledRideBlock({ at: '10/10/2026, 1:21:00 PM' })).toBe(
      sentence('for 10/10/2026, 1:21:00 PM'),
    )
  })

  it('names the awaited tasks of an await', () => {
    expect(buildScheduledRideBlock({ awaiting: ['a1'] })).toBe(
      sentence('for when a1 lands'),
    )
    expect(buildScheduledRideBlock({ awaiting: ['a1', 'b2'] })).toBe(
      sentence('for when a1, b2 have all landed'),
    )
  })

  it('names both triggers of a ride that has both', () => {
    expect(buildScheduledRideBlock({ at: '1:21:00 PM', awaiting: ['a1'] })).toBe(
      sentence('for 1:21:00 PM or when a1 lands, whichever comes first'),
    )
  })

  it('names a watch’s watcher and arguments', () => {
    expect(
      buildScheduledRideBlock({
        watching: { watcher: 'file-changed', args: { path: 'out.log' } },
      }),
    ).toBe(
      '<ride-scheduled>\n' +
        'You are watching `file-changed` (path=out.log); it wakes you when it ' +
        'fires. It stays armed unless you clear it with `lander ride --clear`; ' +
        'scheduling another ride with `lander ride` replaces it.\n' +
        '</ride-scheduled>',
    )
  })
})

describe('prepareUserMessagePrompt', () => {
  function makeCtx(
    initial: Record<string, unknown> = {},
    checkout?: string,
  ) {
    const store = { ...initial }
    return {
      store,
      ctx: {
        task: { taskId: 't1', root: '/repo', ...(checkout ? { checkout } : {}) },
        turn: {
          prompts: ['do work'],
          manifestBlock: '<attached-files/>',
          revivedBlock: '<task-revived/>',
          scheduledRideBlock: '<ride-scheduled/>',
        },
        state: {
          get: (path: string[]) => store[path[0]],
          set: (path: string[], value: unknown) => {
            store[path[0]] = value
          },
        },
      },
    }
  }

  it('delivers task prompt and project doc on a fresh session and suppresses unchanged ones after commit', () => {
    const { store, ctx } = makeCtx({}, '/repo/.worktrees/t1')
    const docs: Record<string, string> = {
      '/repo': 'Root doc',
      '/repo/.worktrees/t1': 'Checkout doc',
    }
    const first = prepareUserMessagePrompt(ctx, {
      sessionId: undefined,
      taskPromptTemplate: TEMPLATE,
      readProjectDoc: (dir) => docs[dir],
    })
    expect(first.prompt).toContain('This task id is t1.')
    expect(first.prompt).toContain('git worktree lander created for it at `/repo/.worktrees/t1`')
    expect(first.prompt).toContain('Checkout doc')
    expect(first.prompt).not.toContain('Root doc')
    expect(first.prompt).toContain(
      'do work\n\n<attached-files/>\n\n<task-revived/>\n\n<ride-scheduled/>',
    )
    expect(store).toEqual({})

    first.commitDelivered()
    expect(store.taskPrompt).toMatch(/^sha256:/)
    expect(store.landerDoc).toBe(deliveryDigest('Checkout doc'))

    const second = prepareUserMessagePrompt(ctx, {
      sessionId: 'sess-1',
      taskPromptTemplate: TEMPLATE,
      readProjectDoc: (dir) => docs[dir],
    })
    expect(second.prompt).toBe(
      'do work\n\n<attached-files/>\n\n<task-revived/>\n\n<ride-scheduled/>',
    )
  })
})
