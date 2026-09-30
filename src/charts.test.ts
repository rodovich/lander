import { describe, it, expect } from 'vitest'
import { heatStep, niceStep, readout } from './charts'

describe('heatStep', () => {
  it('leaves zero empty and spreads the rest over five shades', () => {
    expect(heatStep(0, 10)).toBe(-1)
    expect(heatStep(1, 10)).toBe(0)
    expect(heatStep(2, 10)).toBe(0)
    expect(heatStep(3, 10)).toBe(1)
    expect(heatStep(9, 10)).toBe(4)
    expect(heatStep(10, 10)).toBe(4)
  })
})

describe('niceStep', () => {
  it('picks 1, 2, or 5 times a power of ten', () => {
    expect(niceStep(0)).toBe(1)
    expect(niceStep(7)).toBe(2)
    expect(niceStep(140)).toBe(50)
    expect(niceStep(2.7)).toBe(1)
  })
})

describe('readout', () => {
  const turns = { key: 't', label: 'Turns', readout: { one: 'turn', other: 'turns' } }

  it('rounds to a whole number and words it by that number', () => {
    expect(readout(1.2, turns)).toEqual(['1', 'turn'])
    expect(readout(2.6, turns)).toEqual(['3', 'turns'])
    expect(readout(0, turns)).toEqual(['0', 'turns'])
  })

  it('falls back to the label for a series with no readout', () => {
    expect(readout(4, { key: 'm', label: 'model-x' })).toEqual(['4', 'model-x'])
  })
})
