import { describe, expect, it } from 'vitest'
import { MonotonicRequestGate } from './requestOrder'

describe('MonotonicRequestGate', () => {
  it('rejects an older request after a newer one has settled', () => {
    const gate = new MonotonicRequestGate()
    const older = gate.begin()
    const newer = gate.begin()

    expect(gate.settle(newer)).toBe(true)
    expect(gate.settle(older)).toBe(false)
  })

  it('allows an older response before its newer successor settles', () => {
    const gate = new MonotonicRequestGate()
    const older = gate.begin()
    const newer = gate.begin()

    expect(gate.settle(older)).toBe(true)
    expect(gate.settle(newer)).toBe(true)
  })

  it('invalidates every request from a torn-down scope', () => {
    const gate = new MonotonicRequestGate()
    const stale = gate.begin()
    gate.invalidate()

    expect(gate.settle(stale)).toBe(false)
    expect(gate.settle(gate.begin())).toBe(true)
  })
})
