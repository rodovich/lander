import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CheckoutChanges } from './checkoutChip'
import type { CheckoutReport } from './types'

const heads = (checkout: CheckoutReport) =>
  [
    ...renderToStaticMarkup(<CheckoutChanges checkout={checkout} />).matchAll(
      /checkout-files-head">([^<]*)</g,
    ),
  ].map((m) => m[1])

const file = (path: string) => ({ path, added: 1, removed: 0 })

describe('CheckoutChanges', () => {
  it('lists committed and uncommitted changes apart, leaving out an empty side', () => {
    const report = { path: '/p', files: [file('a.ts'), file('build/out.js')] }
    const split = (commits: number, committed: string[], uncommitted: string[]) => ({
      ...report,
      split: { commits, committed: committed.map(file), uncommitted: uncommitted.map(file) },
    })
    expect(heads(split(2, ['a.ts'], ['build/out.js']))).toEqual([
      'Committed (2 commits)',
      'Uncommitted',
    ])
    expect(heads(split(1, ['a.ts'], []))).toEqual(['Committed (1 commit)'])
    expect(heads(split(0, [], ['a.ts']))).toEqual(['Uncommitted'])
    expect(heads({ ...split(0, [], []), files: [] })).toEqual(['No changes'])
  })

  it('lists a report from before the split as one list', () => {
    expect(heads({ path: '/p', files: [file('a.ts'), file('b.ts')] })).toEqual(['2 files changed'])
    expect(heads({ path: '/p', files: [] })).toEqual(['No changes'])
  })
})
