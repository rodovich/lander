import { describe, expect, it } from 'vitest'
import { taskMetadata } from './task-metadata.js'

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
