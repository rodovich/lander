import { describe, it, expect } from 'vitest'
import { normalizeStatus, reviveTask } from './migrate'

describe('normalizeStatus', () => {
  it('rewrites a legacy stored `resting` to the collapsed `riding`', () => {
    expect(normalizeStatus({ status: 'resting' })).toEqual({ status: 'riding' })
  })

  it('leaves the collapsed vocabulary (riding/wedged/landed) untouched', () => {
    for (const status of ['riding', 'wedged', 'landed']) {
      expect(normalizeStatus({ status })).toEqual({ status })
    }
  })

  it('is idempotent', () => {
    const once = normalizeStatus({ status: 'resting' })
    expect(normalizeStatus({ ...once })).toEqual(once)
  })

  it('preserves the rest of the record and mutates in place', () => {
    const rec = { id: 'x', status: 'resting', title: 't', messages: [] }
    const out = normalizeStatus(rec)
    expect(out).toBe(rec)
    expect(out).toEqual({ id: 'x', status: 'riding', title: 't', messages: [] })
  })

})

describe('reviveTask', () => {
  it('applies the status normalization (the sole rule until step 4)', () => {
    expect(reviveTask({ status: 'resting' })).toEqual({ status: 'riding' })
  })
})
