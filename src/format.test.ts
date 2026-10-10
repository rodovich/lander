import { describe, expect, it } from 'vitest'
import { formatDuration, formatHoursMinutes } from './format'

describe('formatDuration', () => {
  it('shows seconds alone under a minute', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(12_000)).toBe('12s')
    expect(formatDuration(59_400)).toBe('59s')
  })

  it('shows minutes and seconds under an hour', () => {
    expect(formatDuration(60_000)).toBe('1m 0s')
    expect(formatDuration(83_000)).toBe('1m 23s')
    expect(formatDuration(59 * 60_000 + 59_000)).toBe('59m 59s')
  })

  it('drops seconds once hours lead, staying at two terms', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m')
    expect(formatDuration(83 * 60_000 + 45_000)).toBe('1h 23m')
    expect(formatDuration(100 * 3_600_000)).toBe('100h 0m')
  })

  it('rounds to the nearest second rather than truncating', () => {
    expect(formatDuration(1_600)).toBe('2s')
    // 59.6s rounds to 60s, which is a minute — the leading term has to follow.
    expect(formatDuration(59_600)).toBe('1m 0s')
  })

  it('floors a negative span at zero', () => {
    expect(formatDuration(-5_000)).toBe('0s')
  })
})

describe('formatHoursMinutes', () => {
  it('words minutes alone under an hour', () => {
    expect(formatHoursMinutes(15 * 60_000)).toBe('15 minutes')
    expect(formatHoursMinutes(60_000)).toBe('1 minute')
    expect(formatHoursMinutes(20_000)).toBe('0 minutes')
  })

  it('words hours, and minutes when there are any', () => {
    expect(formatHoursMinutes(130 * 60_000)).toBe('2 hours, 10 minutes')
    expect(formatHoursMinutes(61 * 60_000)).toBe('1 hour, 1 minute')
    expect(formatHoursMinutes(2 * 3_600_000)).toBe('2 hours')
  })

  it('rounds to the nearest minute', () => {
    expect(formatHoursMinutes(59 * 60_000 + 40_000)).toBe('1 hour')
  })
})
