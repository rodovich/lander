import { describe, expect, it } from 'vitest'
import {
  admitTask,
  beginTaskPatch,
  createTaskMutationFence,
  insertTask,
  mergeTaskRefresh,
  patchTask,
  removeTask,
  replaceTask,
  settleTaskPatch,
  settleTaskRemoval,
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

  it('keeps an admitted task through a refresh that predates it, until one carries it', () => {
    const fence = createTaskMutationFence()
    const existing = task('a', 'riding')
    const issuedBefore = fence.clock
    const created = task('new', 'riding')
    admitTask(fence, created)
    const current = insertTask([existing], created)
    expect(current.map((t) => t.id)).toEqual(['new', 'a'])

    // A poll issued before the POST answered omits the task; the row stays.
    const stale = mergeTaskRefresh(fence, issuedBefore, current, [
      task('a', 'landed'),
    ])
    expect(stale.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'a', status: 'landed' },
      { id: 'new', status: 'riding' },
    ])

    // A poll issued afterwards is authoritative: its copy replaces the admitted
    // one, and were it to omit the task, the omission would stand.
    const issuedAfter = fence.clock
    const named = task('new', 'riding', { title: 'Named by haiku' })
    const fresh = mergeTaskRefresh(fence, issuedAfter, stale, [named, task('a', 'landed')])
    expect(fresh[0]).toBe(named)
    expect(
      mergeTaskRefresh(fence, issuedAfter, stale, [task('a', 'landed')]).map((t) => t.id),
    ).toEqual(['a'])
  })

  it('keeps a removed task out of a refresh issued before or during the removal', () => {
    const fence = createTaskMutationFence()
    const a = task('a', 'landed')
    const b = task('b', 'riding')
    const issuedBefore = fence.clock
    const handle = beginTaskPatch(fence, a, 'removed')
    const issuedDuring = fence.clock
    const current = removeTask([a, b], handle.key)

    for (const issuedAt of [issuedBefore, issuedDuring]) {
      const merged = mergeTaskRefresh(fence, issuedAt, current, [
        task('a', 'landed'),
        task('b', 'landed'),
      ])
      expect(merged.map(({ id, status }) => ({ id, status }))).toEqual([
        { id: 'b', status: 'landed' },
      ])
    }

    // Once the move succeeds, a refresh that began while it was in flight still
    // can't bring the row back; one issued afterwards is authoritative.
    expect(settleTaskRemoval(fence, handle, true)).toBeNull()
    expect(
      mergeTaskRefresh(fence, issuedDuring, current, [task('a', 'landed'), b]).map(
        (t) => t.id,
      ),
    ).toEqual(['b'])
    expect(
      mergeTaskRefresh(fence, fence.clock, current, [task('a', 'landed'), b]).map(
        (t) => t.id,
      ),
    ).toEqual(['a', 'b'])
  })

  it('reinstates a task whose removal fails, from the newest server copy', () => {
    const fence = createTaskMutationFence()
    const a = task('a', 'landed')
    const handle = beginTaskPatch(fence, a, 'removed')
    const issuedAt = fence.clock
    mergeTaskRefresh(fence, issuedAt, [], [
      task('a', 'landed', { title: 'renamed meanwhile' }),
    ])

    const reinstated = settleTaskRemoval(fence, handle, false)
    expect(reinstated).toMatchObject({ id: 'a', title: 'renamed meanwhile' })
    expect(insertTask([], reinstated!).map((t) => t.id)).toEqual(['a'])
  })

  it('replaces rather than duplicates a task admitted twice', () => {
    const first = task('new', 'riding')
    const again = task('new', 'riding', { title: 'again' })
    expect(insertTask(insertTask([], first), again)).toEqual([again])
  })
})
