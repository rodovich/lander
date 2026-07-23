import { describe, expect, it } from 'vitest'
import { inDateRange, matchesText, taskMetadata } from './task-metadata.js'

describe('taskMetadata', () => {
  it('keeps only id/title/status/timestamps, dropping the conversation', () => {
    const task = {
      id: 'MUuCmBrtqy',
      title: 'Enhance lander task search capabilities',
      status: 'riding',
      createdAt: '2026-06-30T20:25:23.750Z',
      updatedAt: '2026-06-30T20:25:26.253Z',
      seenAt: '2026-06-30T20:25:23.750Z',
      allowEdits: true,
      token: 'secret',
      messages: [{ role: 'user', text: 'hi', createdAt: '2026-06-30T20:25:23.750Z' }],
      events: [{ kind: 'launched', createdAt: '2026-06-30T20:25:23.750Z' }],
    }
    expect(taskMetadata(task)).toEqual({
      id: 'MUuCmBrtqy',
      title: 'Enhance lander task search capabilities',
      status: 'riding',
      createdAt: '2026-06-30T20:25:23.750Z',
      updatedAt: '2026-06-30T20:25:26.253Z',
    })
  })

  it('includes scheduledFor only when the task is resting on a timer', () => {
    const resting = taskMetadata({
      id: 'abc',
      title: 'Wake later',
      status: 'resting',
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
      scheduledFor: '2026-07-01T00:00:00.000Z',
    })
    expect(resting.scheduledFor).toBe('2026-07-01T00:00:00.000Z')

    const unscheduled = taskMetadata({
      id: 'def',
      title: 'Riding now',
      status: 'riding',
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
    })
    expect(unscheduled).not.toHaveProperty('scheduledFor')
  })

  it('surfaces a pending scheduled relaunch as scheduledFor, flagged relaunching', () => {
    const relaunching = taskMetadata({
      id: 'jkl',
      title: 'Fresh session later',
      status: 'riding',
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
      scheduledMessages: [
        { text: 'again', deliverAt: '2026-07-01T00:00:00.000Z', relaunch: true },
      ],
    })
    expect(relaunching.scheduledFor).toBe('2026-07-01T00:00:00.000Z')
    expect(relaunching.relaunching).toBe(true)

    // A task's own scheduledFor (a launch/rest timer) takes priority over a
    // pending relaunch's deliverAt.
    const both = taskMetadata({
      id: 'mno',
      title: 'Both armed',
      status: 'resting',
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
      scheduledFor: '2026-07-02T00:00:00.000Z',
      scheduledMessages: [
        { text: 'again', deliverAt: '2026-07-01T00:00:00.000Z', relaunch: true },
      ],
    })
    expect(both.scheduledFor).toBe('2026-07-02T00:00:00.000Z')
    expect(both).not.toHaveProperty('relaunching')

    // A relaunch armed purely on --await (no deliverAt) has nothing to show yet.
    const awaitOnly = taskMetadata({
      id: 'pqr',
      title: 'Awaiting only',
      status: 'resting',
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
      scheduledMessages: [{ text: 'again', waitFor: ['other'], relaunch: true }],
    })
    expect(awaitOnly).not.toHaveProperty('scheduledFor')
    expect(awaitOnly).not.toHaveProperty('relaunching')
  })

  it('flags repeats only when a scheduled message carries a repeat spec', () => {
    const base = {
      id: 'ghi',
      title: 'Repeating relaunch',
      status: 'resting',
      createdAt: '2026-06-30T00:00:00.000Z',
      updatedAt: '2026-06-30T00:00:00.000Z',
    }
    const repeating = taskMetadata({
      ...base,
      scheduledMessages: [
        { text: 'again', deliverAt: '2026-07-01T00:00:00.000Z', repeat: { interval: 60 } },
      ],
    })
    expect(repeating.repeats).toBe(true)

    // A one-shot deferred message (no repeat spec) is not a repeat.
    const oneShot = taskMetadata({
      ...base,
      scheduledMessages: [{ text: 'later', deliverAt: '2026-07-01T00:00:00.000Z' }],
    })
    expect(oneShot).not.toHaveProperty('repeats')

    expect(taskMetadata(base)).not.toHaveProperty('repeats')
  })
})

describe('inDateRange', () => {
  const since = Date.parse('2026-06-15T00:00:00.000Z')
  const until = Date.parse('2026-06-20T00:00:00.000Z')

  it('passes everything when neither bound is set', () => {
    expect(inDateRange('2020-01-01T00:00:00.000Z', {})).toBe(true)
  })

  it('excludes a createdAt before --since', () => {
    expect(inDateRange('2026-06-14T23:59:59.999Z', { since })).toBe(false)
  })

  it('excludes a createdAt after --until', () => {
    expect(inDateRange('2026-06-20T00:00:00.001Z', { until })).toBe(false)
  })

  it('includes the bounds themselves (inclusive)', () => {
    expect(inDateRange('2026-06-15T00:00:00.000Z', { since })).toBe(true)
    expect(inDateRange('2026-06-20T00:00:00.000Z', { until })).toBe(true)
  })

  it('includes a createdAt within both bounds', () => {
    expect(inDateRange('2026-06-17T00:00:00.000Z', { since, until })).toBe(true)
  })
})

describe('matchesText', () => {
  const task = {
    id: 'MUuCmBrtqy',
    title: 'Fix the Auth timeout',
    items: [
      { kind: 'message', role: 'user', text: 'sessions are dropping after a few minutes' },
      { kind: 'message', role: 'flow', text: 'found it — the refresh token expires early' },
    ],
  }

  it('matches with no groups', () => {
    expect(matchesText(task, [])).toBe(true)
  })

  it('matches a term in the title, case-insensitively', () => {
    expect(matchesText(task, [['auth']])).toBe(true)
  })

  it('matches a term only found in a message', () => {
    expect(matchesText(task, [['refresh token']])).toBe(true)
  })

  it('ORs terms within a single group', () => {
    expect(matchesText(task, [['nonexistent', 'timeout']])).toBe(true)
  })

  it('ANDs across groups, failing if any group has no match', () => {
    expect(matchesText(task, [['auth'], ['timeout']])).toBe(true)
    expect(matchesText(task, [['auth'], ['nonexistent']])).toBe(false)
  })

  it('matches a term equal to the task id', () => {
    expect(matchesText(task, [['MUuCmBrtqy']])).toBe(true)
  })

  it('does not match an id prefix or a differently-cased id', () => {
    expect(matchesText(task, [['MUuCmB']])).toBe(false)
    expect(matchesText(task, [['muucmbrtqy']])).toBe(false)
  })
})
