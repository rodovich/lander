import { describe, expect, it } from 'vitest'
import { detailHeaderLabel, formatDuration } from './format'

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

describe('detailHeaderLabel', () => {
  const project = '/Users/me/code/easel'

  // The regression this function exists for: the badge used to be derived from
  // the task's cwd, so a task that had merely `cd`'d into a worktree — with the
  // next turn launching back at the project root — was labelled as being in one.
  // `worktree` is now the only input that can name one, which is why no cwd
  // reaches this function at all.
  it('omits the line entirely with one project and no worktree', () => {
    expect(detailHeaderLabel({ project, projectCount: 1 })).toBeNull()
  })

  it('names the project alone when more than one is served', () => {
    expect(detailHeaderLabel({ project, projectCount: 2 })).toBe('easel')
  })

  it('appends the recorded worktree, even for a single project', () => {
    expect(
      detailHeaderLabel({ project, projectCount: 1, worktree: 'share-checkbox' }),
    ).toBe('easel • share-checkbox')
  })

  it('pairs project and worktree when both are worth showing', () => {
    expect(
      detailHeaderLabel({ project, projectCount: 3, worktree: 'share-checkbox' }),
    ).toBe('easel • share-checkbox')
  })
})
