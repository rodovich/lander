import { describe, expect, it } from 'vitest'
import {
  beginTaskPatch,
  createTaskMutationFence,
  mergeTaskRefresh,
  patchTask,
  replaceTask,
  settleTaskPatch,
} from './taskMutationFence'
import type { TaskWithProject } from './types'

const task = (
  id: string,
  status: string,
  extra: Partial<TaskWithProject> = {},
): TaskWithProject => ({
  id,
  projectSlug: 'p',
  title: id,
  status,
  createdAt: '2026-01-01T00:00:00.000Z',
  allowEdits: false,
  items: [],
  ...extra,
})

describe('task mutation fence', () => {
  it('keeps a pre-mutation refresh from reverting only the mutated task', () => {
    const fence = createTaskMutationFence()
    const a = task('a', 'riding')
    const b = task('b', 'riding')
    const issuedAt = fence.clock
    const handle = beginTaskPatch(fence, a, { status: 'landed' })
    const current = patchTask([a, b], handle.key, { status: 'landed' })

    const merged = mergeTaskRefresh(fence, issuedAt, current, [
      task('a', 'riding'),
      task('b', 'landed'),
    ])

    expect(merged.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'a', status: 'landed' },
      { id: 'b', status: 'landed' },
    ])
  })

  it('lays an optimistic patch over a refresh issued during the mutation', () => {
    const fence = createTaskMutationFence()
    const a = task('a', 'riding')
    const b = task('b', 'riding')
    const handle = beginTaskPatch(fence, a, { status: 'landed' })
    const issuedAt = fence.clock
    const current = patchTask([a, b], handle.key, { status: 'landed' })

    const merged = mergeTaskRefresh(fence, issuedAt, current, [
      task('a', 'riding', { title: 'new server title' }),
      task('b', 'landed'),
    ])
    expect(merged[0]).toMatchObject({
      id: 'a',
      status: 'landed',
      title: 'new server title',
    })
    expect(merged[1].status).toBe('landed')

    const rollback = settleTaskPatch(fence, handle)
    expect(rollback).toMatchObject({
      id: 'a',
      status: 'riding',
      title: 'new server title',
    })
  })

  it('protects the PATCH response while accepting unrelated refresh changes', () => {
    const fence = createTaskMutationFence()
    const a = task('a', 'riding')
    const b = task('b', 'riding')
    const handle = beginTaskPatch(fence, a, { status: 'landed' })
    const issuedAt = fence.clock
    let current = patchTask([a, b], handle.key, { status: 'landed' })
    const updated = task('a', 'landed', {
      updatedAt: '2026-01-01T00:00:01.000Z',
    })
    const settled = settleTaskPatch(fence, handle, updated)
    expect(settled).not.toBeNull()
    current = replaceTask(current, handle.key, settled!)

    const merged = mergeTaskRefresh(fence, issuedAt, current, [
      task('a', 'riding'),
      task('b', 'landed'),
    ])
    expect(merged[0]).toBe(updated)
    expect(merged[1].status).toBe('landed')
  })
})
