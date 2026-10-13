// The task prompt template carries an {{id}} slot so the agent is told its own
// task id up front — an agent that knows its id won't mistake its own row in
// `lander list` for a separate "sibling" task (see task DrNwYlXD7L). These lock
// the substitution and guard against a leftover placeholder reaching the child.

import { describe, expect, it } from 'vitest'
import {
  buildRevivedBlock,
  buildScheduledRideBlock,
  fillTaskPrompt,
  taskManagementPrompt,
  promptWithTaskManagement,
} from './task-management'

const TEMPLATE = 'You are running inside a lander task. This task id is {{id}}. {{forwardable}}.'

describe('fillTaskPrompt', () => {
  it('substitutes both {{id}} and {{forwardable}} and leaves no placeholder', () => {
    const out = fillTaskPrompt(TEMPLATE, 'FWD', 'abc123')
    expect(out).toContain('This task id is abc123.')
    expect(out).toContain('FWD.')
    expect(out).not.toContain('{{')
  })
})

describe('taskManagementPrompt / promptWithTaskManagement', () => {
  it('threads the id through (not the task object, which has no id)', () => {
    const task = { allowEdits: false }
    const managed = taskManagementPrompt(task, TEMPLATE, 'task-xyz')
    expect(managed).toContain('This task id is task-xyz.')
    expect(managed).not.toContain('{{id}}')
  })

  it('appends the caller prompt after the filled template', () => {
    const task = { allowEdits: true }
    const full = promptWithTaskManagement(task, 'DO THE THING', TEMPLATE, 'task-xyz')
    expect(full).toContain('This task id is task-xyz.')
    expect(full.endsWith('DO THE THING')).toBe(true)
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
})
