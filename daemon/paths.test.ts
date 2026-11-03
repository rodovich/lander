import { describe, expect, it } from 'vitest'
import { isInside } from './paths'

describe('isInside', () => {
  it('holds only for paths strictly under the directory', () => {
    expect(isInside('/repo', '/repo/a/b')).toBe(true)
    expect(isInside('/repo', '/repo/..cache')).toBe(true)
    expect(isInside('/repo', '/repo')).toBe(false)
    expect(isInside('/repo', '/repo/../other')).toBe(false)
    expect(isInside('/repo', '/repository')).toBe(false)
  })
})
