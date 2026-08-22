import { describe, expect, it } from 'vitest'
import { latestUpdateAt } from './taskMeta'
import type { Task } from './types'

describe('latestUpdateAt', () => {
  it('does not count the acting task’s own task-action row as unread activity', () => {
    const task = {
      id: 'actor',
      title: 'Actor',
      status: 'riding',
      createdAt: '2026-08-21T19:00:00.000Z',
      allowEdits: false,
      items: [
        {
          id: 'a1',
          at: '2026-08-21T20:00:00.000Z',
          kind: 'task-action',
          action: 'launch',
          target: { id: 'child', projectSlug: 'proj' },
        },
      ],
      rides: [],
    } as Task
    expect(latestUpdateAt(task)).toBe('')
  })
})
