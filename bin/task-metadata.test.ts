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
      allowCommits: true,
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
    title: 'Fix the Auth timeout',
    messages: [
      { role: 'user', text: 'sessions are dropping after a few minutes' },
      { role: 'assistant', text: 'found it — the refresh token expires early' },
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
})
