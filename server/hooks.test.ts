// The approval store and the join. Everything here is repository-free by
// construction: a (path, blob) pair is an opaque string pair, and no test needs a
// git repository to state what approving one means.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  approveHookPairs,
  candidatePairs,
  effectiveApprovals,
  emptyHooksStore,
  isSafeTrustRoot,
  joinResolution,
  pairKey,
  readHooksStore,
  selectorsFor,
  setTrustRoot,
  type HooksStore,
} from './hooks'
import type { HooksResolution } from './protocol'

const AT = '2026-01-01T00:00:00.000Z'
const CLEANUP = '.lander/hooks/landed/any/cleanup.js'
const VERIFY = '.lander/hooks/landed/agent/verify.js'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lander-hooks-store-'))
  file = path.join(dir, 'nested', 'hooks.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('the store', () => {
  it('starts empty, and reads back what was approved', async () => {
    expect(await readHooksStore(file)).toEqual(emptyHooksStore())
    await approveHookPairs(file, [{ path: CLEANUP, blob: 'b1' }], 'content', {
      at: AT,
    })
    expect((await readHooksStore(file)).approved).toEqual([
      { path: CLEANUP, blob: 'b1', via: 'content', at: AT },
    ])
  })

  // Monotonic: approving a new version never un-approves an old one, which is
  // what keeps a pending version from blocking anything and lets a tree that has
  // not pulled the new one keep running what it has.
  it('adds versions without displacing earlier ones', async () => {
    await approveHookPairs(file, [{ path: CLEANUP, blob: 'b1' }], 'content', { at: AT })
    await approveHookPairs(file, [{ path: CLEANUP, blob: 'b2' }], 'content', { at: AT })
    const approvals = effectiveApprovals(await readHooksStore(file))
    expect(approvals.get(pairKey({ path: CLEANUP, blob: 'b1' }))).toBe('content')
    expect(approvals.get(pairKey({ path: CLEANUP, blob: 'b2' }))).toBe('content')
  })

  it('records a pair once however often it is approved the same way', async () => {
    for (let i = 0; i < 3; i++)
      await approveHookPairs(file, [{ path: CLEANUP, blob: 'b1' }], 'trust-root', {
        ref: 'origin/main',
        at: AT,
      })
    expect((await readHooksStore(file)).approved).toHaveLength(1)
  })

  it('creates the data dir rather than failing on a project with no tasks yet', async () => {
    await approveHookPairs(file, [{ path: CLEANUP, blob: 'b1' }], 'content', { at: AT })
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      approved: [{ blob: 'b1' }],
    })
  })

  it('starts over from a corrupt file rather than wedging every write', async () => {
    const flat = path.join(dir, 'hooks.json')
    await writeFile(flat, 'not json{')
    expect(await readHooksStore(flat)).toEqual(emptyHooksStore())
    await approveHookPairs(flat, [{ path: CLEANUP, blob: 'b1' }], 'content', { at: AT })
    expect((await readHooksStore(flat)).approved).toHaveLength(1)
  })

  it('designates a trust root without touching the approved set', async () => {
    await approveHookPairs(file, [{ path: CLEANUP, blob: 'b1' }], 'content', { at: AT })
    const store = await setTrustRoot(file, 'origin/main')
    expect(store.trustRoot).toBe('origin/main')
    expect(store.approved).toHaveLength(1)
  })
})

describe('effectiveApprovals', () => {
  const withTrustRoot = (trustRoot: string | null | undefined): HooksStore => ({
    ...(trustRoot === undefined ? {} : { trustRoot }),
    approved: [
      { path: CLEANUP, blob: 'b1', via: 'trust-root', ref: 'origin/main', at: AT },
      { path: VERIFY, blob: 'b2', via: 'content', at: AT },
    ],
  })

  it('counts a trust-root pair while that ref is the designated one', () => {
    const approvals = effectiveApprovals(withTrustRoot('origin/main'))
    expect(approvals.get(pairKey({ path: CLEANUP, blob: 'b1' }))).toBe('trust-root')
  })

  // T6: with the trust root disabled, everything requires content approval. The
  // cached answers stay on disk — re-designating the ref must not rescan — but
  // they stop counting.
  it('drops trust-root pairs when the project refuses a trust root', () => {
    const approvals = effectiveApprovals(withTrustRoot(null))
    expect(approvals.has(pairKey({ path: CLEANUP, blob: 'b1' }))).toBe(false)
    expect(approvals.get(pairKey({ path: VERIFY, blob: 'b2' }))).toBe('content')
  })

  it('drops them when the trust root is re-pointed at another ref', () => {
    const approvals = effectiveApprovals(withTrustRoot('origin/release'))
    expect(approvals.has(pairKey({ path: CLEANUP, blob: 'b1' }))).toBe(false)
  })

  // T4's second half: the pair, not the blob. Moving an approved module from one
  // trigger directory to another fires at a different time, so its approval must
  // not travel with the content.
  it('does not approve the same content at another path', () => {
    const approvals = effectiveApprovals({
      approved: [{ path: '.lander/hooks/wedged/any/x.js', blob: 'b1', via: 'content', at: AT }],
    })
    expect(approvals.has(pairKey({ path: '.lander/hooks/landed/any/x.js', blob: 'b1' }))).toBe(
      false,
    )
  })

  it('prefers a content approval over a cached trust-root one for the same pair', () => {
    const approvals = effectiveApprovals({
      trustRoot: 'origin/main',
      approved: [
        { path: CLEANUP, blob: 'b1', via: 'trust-root', ref: 'origin/main', at: AT },
        { path: CLEANUP, blob: 'b1', via: 'content', at: AT },
      ],
    })
    expect(approvals.get(pairKey({ path: CLEANUP, blob: 'b1' }))).toBe('content')
  })
})

describe('isSafeTrustRoot', () => {
  it('accepts a remote-tracking ref and refuses anything flag-shaped', () => {
    expect(isSafeTrustRoot('origin/main')).toBe(true)
    expect(isSafeTrustRoot('--upload-pack=evil')).toBe(false)
    expect(isSafeTrustRoot('origin/../HEAD')).toBe(false)
  })
})

describe('joinResolution', () => {
  const resolution = (declared: HooksResolution['declared']): HooksResolution => ({
    cwd: '/proj',
    commit: 'c1',
    declared,
  })
  const declaration = (blob: string, ancestry: string[] = []) => ({
    path: CLEANUP,
    blob,
    trigger: 'landed',
    by: 'any',
    name: 'cleanup',
    ancestry,
  })

  it('runs the declared version when it is approved', () => {
    const [hook] = joinResolution(
      resolution([declaration('b2', ['b1'])]),
      new Map([[pairKey({ path: CLEANUP, blob: 'b2' }), 'content' as const]]),
    )
    expect(hook).toMatchObject({ state: 'approved', runs: 'b2', via: 'content' })
    expect(hook.reason).toBeUndefined()
  })

  // T5 / T3: an unapproved version does not block anything — the most recent
  // approved version in the path's ancestry runs, and the declared one sits
  // pending. That is also what an uncommitted edit resolves to, since the edit
  // is not a candidate at all and the committed blob is what arrives here.
  it('falls back to the most recent approved ancestor', () => {
    const [hook] = joinResolution(
      resolution([declaration('b3', ['b2', 'b1'])]),
      new Map([
        [pairKey({ path: CLEANUP, blob: 'b1' }), 'content' as const],
        [pairKey({ path: CLEANUP, blob: 'b2' }), 'content' as const],
      ]),
    )
    expect(hook).toMatchObject({
      state: 'pending',
      runs: 'b2',
      reason: 'unapproved-version',
    })
  })

  it('resolves to nothing, with a reason, when no version of the path is approved', () => {
    const [hook] = joinResolution(resolution([declaration('b3', ['b2'])]), new Map())
    expect(hook).toMatchObject({
      state: 'pending',
      runs: null,
      reason: 'no-approved-version',
    })
    expect(hook.searchTruncated).toBeUndefined()
  })

  it('says when the ancestry walk was cut short, so a miss is not read as absence', () => {
    const [hook] = joinResolution(
      resolution([{ ...declaration('b3', ['b2']), ancestryTruncated: true }]),
      new Map(),
    )
    expect(hook).toMatchObject({ runs: null, searchTruncated: true })
  })

  it('is empty when the tree declares nothing', () => {
    expect(joinResolution({ cwd: '/proj', declared: [] }, new Map())).toEqual([])
    expect(joinResolution({ cwd: '/proj', reason: 'not-a-repo' }, new Map())).toEqual([])
  })
})

describe('candidatePairs', () => {
  it('raises a question about every version of a path, not just the declared one', () => {
    expect(
      candidatePairs({
        cwd: '/proj',
        declared: [
          {
            path: CLEANUP,
            blob: 'b2',
            trigger: 'landed',
            by: 'any',
            name: 'cleanup',
            ancestry: ['b1'],
          },
        ],
      }),
    ).toEqual([
      { path: CLEANUP, blob: 'b2' },
      { path: CLEANUP, blob: 'b1' },
    ])
  })
})

describe('selectorsFor', () => {
  it('selects the principal that acted and `any` beside it', () => {
    expect(selectorsFor('landed', 'agent')).toEqual([
      { trigger: 'landed', by: 'agent' },
      { trigger: 'landed', by: 'any' },
    ])
  })

  it('does not select `any` twice', () => {
    expect(selectorsFor('landed', 'any')).toEqual([{ trigger: 'landed', by: 'any' }])
  })
})
