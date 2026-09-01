import { describe, expect, it } from 'vitest'
import { detailHeaderLabel } from './format'

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
