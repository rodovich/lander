import { describe, expect, it } from 'vitest'
import { createComposedStore } from './composed'

describe('composed message store', () => {
  it('returns a composed message by its id', () => {
    const store = createComposedStore()
    const id = store.put('proj', 'task-1', { message: 'fix the bug' })
    expect(store.get('proj', 'task-1', id)).toEqual({ message: 'fix the bug' })
  })

  it('keeps whether the composer will manage the launch', () => {
    const store = createComposedStore()
    const id = store.put('proj', 'task-1', { message: 'run the probe', managed: true })
    expect(store.get('proj', 'task-1', id)).toEqual({ message: 'run the probe', managed: true })
  })

  it('gives each composition its own id', () => {
    const store = createComposedStore()
    const a = store.put('proj', 'task-1', { message: 'first' })
    const b = store.put('proj', 'task-1', { message: 'second' })
    expect(a).not.toBe(b)
    expect(store.get('proj', 'task-1', a)?.message).toBe('first')
    expect(store.get('proj', 'task-1', b)?.message).toBe('second')
  })

  it("does not return another task's message", () => {
    const store = createComposedStore()
    const id = store.put('proj', 'task-1', { message: 'mine' })
    expect(store.get('proj', 'task-2', id)).toBeUndefined()
    expect(store.get('other', 'task-1', id)).toBeUndefined()
  })

  it('forgets a message after a day', () => {
    let t = 0
    const store = createComposedStore(() => t)
    const id = store.put('proj', 'task-1', { message: 'stale' })
    t = 24 * 60 * 60 * 1000 + 1
    expect(store.get('proj', 'task-1', id)).toBeUndefined()
  })
})
