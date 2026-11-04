import { describe, expect, it } from 'vitest'
import { runWatcher } from './index'
import { PermanentWatcherError, type BundledWatcher } from './types'

const CTX = { cwd: '/repo' }

function fake(run: BundledWatcher['run']): BundledWatcher[] {
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

describe('runWatcher', () => {
  it('refuses an unknown watcher and bad arguments as permanent errors', async () => {
    expect(await runWatcher('nope', CTX, {}, undefined, 5_000, quiet)).toMatchObject({
      kind: 'error',
      permanent: true,
    })
    expect(await runWatcher('fake', CTX, {}, undefined, 5_000, quiet)).toMatchObject({
      kind: 'error',
      permanent: true,
      error: expect.stringMatching(/thing/),
    })
    for (const extra of ['extra', 'constructor'])
      expect(
        await runWatcher('fake', CTX, { thing: 'a', [extra]: 'b' }, undefined, 5_000, quiet),
      ).toMatchObject({ kind: 'error', permanent: true })
  })

  it('passes the previous state in and reports what the watcher returned', async () => {
    const seen: unknown[] = []
    const watchers = fake(async (_ctx, _args, prev) => {
      seen.push(prev)
      return { fired: true, state: { n: 2 }, message: 'it happened' }
    })
    expect(
      await runWatcher('fake', CTX, { thing: 'a' }, { n: 1 }, 5_000, watchers),
    ).toEqual({ kind: 'fired', state: { n: 2 }, message: 'it happened' })
    expect(seen).toEqual([{ n: 1 }])
    expect(await runWatcher('fake', CTX, { thing: 'a' }, undefined, 5_000, quiet)).toEqual({
      kind: 'quiet',
      state: { n: 1 },
    })
  })

  it('reports a thrown error as temporary unless the watcher marks it permanent', async () => {
    const flaky = fake(async () => {
      throw new Error('flaky')
    })
    expect(await runWatcher('fake', CTX, { thing: 'a' }, undefined, 5_000, flaky)).toEqual({
      kind: 'error',
      error: 'flaky',
      permanent: false,
    })
    const gone = fake(async () => {
      throw new PermanentWatcherError('gone')
    })
    expect(await runWatcher('fake', CTX, { thing: 'a' }, undefined, 5_000, gone)).toEqual({
      kind: 'error',
      error: 'gone',
      permanent: true,
    })
  })

  it('times out a watcher that runs past its budget', async () => {
    const hung = fake(() => new Promise(() => {}))
    expect(await runWatcher('fake', CTX, { thing: 'a' }, undefined, 20, hung)).toMatchObject({
      kind: 'error',
      permanent: false,
      error: expect.stringMatching(/timed out/),
    })
  })
})
