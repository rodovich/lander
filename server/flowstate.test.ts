import { describe, it, expect } from 'vitest'
import { applyStatePatch, type StatePatchTask } from './flowstate'
import type { StatePatchOp } from './protocol'

const set = (path: string[], value: unknown): StatePatchOp => ({ op: 'set', path, value })
const del = (path: string[]): StatePatchOp => ({ op: 'delete', path })
const push = (path: string[], value: unknown): StatePatchOp => ({ op: 'push', path, value })
const patch = (path: string[], value: unknown): StatePatchOp => ({ op: 'patch', path, value })

describe('applyStatePatch', () => {
  it('creates flowState on first write and sets a value', () => {
    const t: StatePatchTask = {}
    applyStatePatch(t, [set(['pr'], 123)], 1)
    expect(t.flowState).toEqual({ pr: 123 })
    expect(t.flowStateRev).toBe(1)
  })

  it('sets at depth, creating intermediate objects', () => {
    const t: StatePatchTask = {}
    applyStatePatch(t, [set(['ci', 'run', 'id'], 4512)], 1)
    expect(t.flowState).toEqual({ ci: { run: { id: 4512 } } })
  })

  it('deletes a key', () => {
    const t: StatePatchTask = { flowState: { a: 1, b: 2 }, flowStateRev: 0 }
    applyStatePatch(t, [del(['a'])], 1)
    expect(t.flowState).toEqual({ b: 2 })
  })

  it('push creates the array then appends', () => {
    const t: StatePatchTask = {}
    applyStatePatch(t, [push(['log'], 'a')], 1)
    applyStatePatch(t, [push(['log'], 'b')], 2)
    expect(t.flowState).toEqual({ log: ['a', 'b'] })
  })

  it('patch shallow-merges into an existing object', () => {
    const t: StatePatchTask = { flowState: { cfg: { a: 1, b: 2 } }, flowStateRev: 0 }
    applyStatePatch(t, [patch(['cfg'], { b: 3, c: 4 })], 1)
    expect(t.flowState).toEqual({ cfg: { a: 1, b: 3, c: 4 } })
  })

  it('patch replaces when the target is not an object', () => {
    const t: StatePatchTask = { flowState: { phase: 'draft' }, flowStateRev: 0 }
    applyStatePatch(t, [patch(['phase'], { step: 1 })], 1)
    expect(t.flowState).toEqual({ phase: { step: 1 } })
  })

  it('increments flowStateRev to the batch rev and applies ops in order', () => {
    const t: StatePatchTask = {}
    applyStatePatch(t, [set(['a'], 1), set(['a'], 2), push(['b'], 'x')], 5)
    expect(t.flowState).toEqual({ a: 2, b: ['x'] })
    expect(t.flowStateRev).toBe(5)
  })

  it('no-ops a batch at or below the current revision (idempotent replay)', () => {
    const t: StatePatchTask = { flowState: { a: 1 }, flowStateRev: 3 }
    applyStatePatch(t, [set(['a'], 999)], 3) // rev == current → skip
    expect(t.flowState).toEqual({ a: 1 })
    expect(t.flowStateRev).toBe(3)
    applyStatePatch(t, [set(['a'], 999)], 2) // rev < current → skip
    expect(t.flowState).toEqual({ a: 1 })
    expect(t.flowStateRev).toBe(3)
    applyStatePatch(t, [set(['a'], 42)], 4) // rev > current → apply
    expect(t.flowState).toEqual({ a: 42 })
    expect(t.flowStateRev).toBe(4)
  })
})
