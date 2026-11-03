import { describe, expect, it } from 'vitest'
import { runCheck } from './index'
import { PermanentCheckError, type BundledCheck } from './types'

const CTX = { cwd: '/repo' }

function fake(run: BundledCheck['run']): BundledCheck[] {
  return [
    {
      meta: {
        name: 'fake',
        description: 'test',
        args: { thing: { required: true, description: 'x' } },
      },
      run,
    },
  ]
}

const quiet = fake(async () => ({ fired: false, state: { n: 1 } }))

describe('runCheck', () => {
  it('refuses an unknown check and bad arguments as permanent errors', async () => {
    expect(await runCheck('nope', CTX, {}, undefined, 5_000, quiet)).toMatchObject({
      kind: 'error',
      permanent: true,
    })
    expect(await runCheck('fake', CTX, {}, undefined, 5_000, quiet)).toMatchObject({
      kind: 'error',
      permanent: true,
      error: expect.stringMatching(/thing/),
    })
    for (const extra of ['extra', 'constructor'])
      expect(
        await runCheck('fake', CTX, { thing: 'a', [extra]: 'b' }, undefined, 5_000, quiet),
      ).toMatchObject({ kind: 'error', permanent: true })
  })

  it('passes the previous state in and reports what the check returned', async () => {
    const seen: unknown[] = []
    const checks = fake(async (_ctx, _args, prev) => {
      seen.push(prev)
      return { fired: true, state: { n: 2 }, message: 'it happened' }
    })
    expect(
      await runCheck('fake', CTX, { thing: 'a' }, { n: 1 }, 5_000, checks),
    ).toEqual({ kind: 'fired', state: { n: 2 }, message: 'it happened' })
    expect(seen).toEqual([{ n: 1 }])
    expect(await runCheck('fake', CTX, { thing: 'a' }, undefined, 5_000, quiet)).toEqual({
      kind: 'quiet',
      state: { n: 1 },
    })
  })

  it('reports a thrown error as temporary unless the check marks it permanent', async () => {
    const flaky = fake(async () => {
      throw new Error('flaky')
    })
    expect(await runCheck('fake', CTX, { thing: 'a' }, undefined, 5_000, flaky)).toEqual({
      kind: 'error',
      error: 'flaky',
      permanent: false,
    })
    const gone = fake(async () => {
      throw new PermanentCheckError('gone')
    })
    expect(await runCheck('fake', CTX, { thing: 'a' }, undefined, 5_000, gone)).toEqual({
      kind: 'error',
      error: 'gone',
      permanent: true,
    })
  })

  it('times out a check that runs past its budget', async () => {
    const hung = fake(() => new Promise(() => {}))
    expect(await runCheck('fake', CTX, { thing: 'a' }, undefined, 20, hung)).toMatchObject({
      kind: 'error',
      permanent: false,
      error: expect.stringMatching(/timed out/),
    })
  })
})
