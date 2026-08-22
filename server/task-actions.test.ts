import { describe, expect, it, vi } from 'vitest'
import { recordTaskAction } from './task-actions'
import type { Item } from './tasks'

const AT = '2026-08-21T20:00:00.000Z'

describe('recordTaskAction', () => {
  it('appends through the injected mutation seam without changing other fields', async () => {
    const actor: { items?: Item[]; updatedAt: string } = {
      items: [],
      updatedAt: 'before',
    }
    await recordTaskAction(
      '/actor.json',
      {
        action: 'launch',
        target: { id: 'child', projectSlug: 'proj' },
      },
      AT,
      async (_file, fn) => fn(actor),
    )
    expect(actor.items).toHaveLength(1)
    expect(actor.items?.[0]).toMatchObject({
      kind: 'task-action',
      action: 'launch',
      at: AT,
    })
    expect(actor.updatedAt).toBe('before')
  })

  it('logs and resolves when the secondary actor append fails', async () => {
    const log = vi.fn()
    await expect(
      recordTaskAction(
        '/missing-actor.json',
        {
          action: 'message',
          target: { id: 'child', projectSlug: 'proj' },
        },
        AT,
        async () => {
          throw new Error('actor was archived')
        },
        log,
      ),
    ).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(
      'failed to record acting task action:',
      expect.objectContaining({ message: 'actor was archived' }),
    )
  })
})
