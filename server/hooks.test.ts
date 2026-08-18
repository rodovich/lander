// The approval store and the join. Everything here is repository-free by
// construction: a (path, blob) pair is an opaque string pair, and no test needs a
// git repository to state what approving one means.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  approveHookPairs,
  candidatePairs,
  clearHookMissCache,
  effectiveApprovals,
  emptyHooksStore,
  isSafeTrustRoot,
  joinResolution,
  pairKey,
  readHooksStore,
  resolveProjectHooks,
  revokeHookPairs,
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

// The half of the feature with no git in it: the daemon's answer joined against
// the store, the trust root's tip cached into it, and the second-phase scan for a
// version that has moved on. Reachable only through a live daemon until the
// `resolve` seam existed, so none of it had ever executed in a test.
describe('resolveProjectHooks', () => {
  const project = {
    path: '/proj',
    slug: 'proj',
    dataDir: '/d',
    runsDir: '/r',
    archiveDir: '/a',
    flowsDir: '/f',
    attachmentsDir: '/at',
    hooksFile: '',
  }
  const declaration = (path: string, blob: string, ancestry: string[] = []) => ({
    path,
    blob,
    trigger: 'landed',
    by: 'any',
    name: 'cleanup',
    ancestry,
  })
  // A stand-in daemon: answers the declare phase from `declared`/`tip`, and the
  // history phase by reporting whichever asked-for pairs are in `inHistory`.
  const daemon = (opts: {
    declared?: ReturnType<typeof declaration>[]
    tip?: { path: string; blob: string }[]
    inHistory?: { path: string; blob: string }[]
    tipCommit?: string
  }) => {
    const calls: unknown[] = []
    const fn = async (input: Record<string, unknown>) => {
      calls.push(input)
      const history = input.history as { pairs: { path: string; blob: string }[] } | undefined
      return {
        ok: true,
        resolution: {
          cwd: '/proj',
          commit: 'c1',
          ...(input.declare ? { declared: opts.declared ?? [] } : {}),
          ...(input.trustRoot
            ? {
                trustRoot: {
                  ref: input.trustRoot as string,
                  commit: opts.tipCommit ?? 'tip1',
                  ...(input.declare ? { tip: opts.tip ?? [] } : {}),
                  ...(history
                    ? {
                        found: history.pairs.filter((p) =>
                          (opts.inHistory ?? []).some(
                            (h) => h.path === p.path && h.blob === p.blob,
                          ),
                        ),
                      }
                    : {}),
                },
              }
            : {}),
        },
      }
    }
    return Object.assign(fn as never as typeof import('./daemon').requestHooksResolution, {
      calls,
    })
  }

  beforeEach(() => {
    project.hooksFile = path.join(dir, 'hooks.json')
    clearHookMissCache()
  })

  it('joins the daemon’s answer against the store', async () => {
    await approveHookPairs(project.hooksFile, [{ path: CLEANUP, blob: 'b1' }], 'content', {
      at: AT,
    })
    const r = await resolveProjectHooks({
      project,
      resolve: daemon({ declared: [declaration(CLEANUP, 'b1')] }),
    })
    expect(r.ok && r.hooks.hooks[0]).toMatchObject({
      state: 'approved',
      via: 'content',
      runs: 'b1',
    })
  })

  // T4's first half, which nothing exercised: a version on the trusted branch is
  // approved with no prompt, and the answer is cached into the store so the git
  // question is asked once rather than per request.
  it('approves what the trusted branch’s tip carries, and records it', async () => {
    await setTrustRoot(project.hooksFile, 'origin/main')
    const r = await resolveProjectHooks({
      project,
      now: () => AT,
      resolve: daemon({
        declared: [declaration(CLEANUP, 'b1')],
        tip: [{ path: CLEANUP, blob: 'b1' }],
      }),
    })
    expect(r.ok && r.hooks.hooks[0]).toMatchObject({
      state: 'approved',
      via: 'trust-root',
    })
    expect((await readHooksStore(project.hooksFile)).approved).toEqual([
      { path: CLEANUP, blob: 'b1', via: 'trust-root', ref: 'origin/main', at: AT },
    ])
  })

  it('does not rewrite the store when the tip carries nothing new', async () => {
    await setTrustRoot(project.hooksFile, 'origin/main')
    const answer = () =>
      daemon({
        declared: [declaration(CLEANUP, 'b1')],
        tip: [{ path: CLEANUP, blob: 'b1' }],
      })
    await resolveProjectHooks({ project, now: () => AT, resolve: answer() })
    const first = await stat(project.hooksFile)
    await new Promise((r) => setTimeout(r, 10))
    await resolveProjectHooks({ project, now: () => AT, resolve: answer() })
    expect((await stat(project.hooksFile)).mtimeMs).toBe(first.mtimeMs)
  })

  // The second phase: a version that reached the trusted branch and has since
  // moved on from its tip is still approved, and only the pairs neither the tip
  // nor the store could answer are asked about.
  it('scans the trusted branch’s history for a version that moved on', async () => {
    await setTrustRoot(project.hooksFile, 'origin/main')
    const ask = daemon({
      declared: [declaration(CLEANUP, 'b2', ['b1'])],
      tip: [],
      inHistory: [{ path: CLEANUP, blob: 'b1' }],
    })
    const r = await resolveProjectHooks({ project, now: () => AT, resolve: ask })
    expect(r.ok && r.hooks.hooks[0]).toMatchObject({
      state: 'pending',
      runs: 'b1',
      runsVia: 'trust-root',
      reason: 'unapproved-version',
    })
    expect(ask.calls).toHaveLength(2)
    expect((ask.calls[1] as { history: { pairs: unknown[] } }).history.pairs).toEqual([
      { path: CLEANUP, blob: 'b2' },
      { path: CLEANUP, blob: 'b1' },
    ])
  })

  // A miss is only worth re-deriving once the branch has moved, so the second
  // phase must not re-run while the tip is unchanged.
  it('asks about a pair the trusted branch does not carry exactly once', async () => {
    await setTrustRoot(project.hooksFile, 'origin/main')
    const opts = { declared: [declaration(CLEANUP, 'b2')], tip: [] }
    const first = daemon(opts)
    await resolveProjectHooks({ project, now: () => AT, resolve: first })
    expect(first.calls).toHaveLength(2)
    const second = daemon(opts)
    await resolveProjectHooks({ project, now: () => AT, resolve: second })
    expect(second.calls).toHaveLength(1)
    // Until it moves: a new tip is a new question.
    const moved = daemon({ ...opts, tipCommit: 'tip2' })
    await resolveProjectHooks({ project, now: () => AT, resolve: moved })
    expect(moved.calls).toHaveLength(2)
  })

  it('does not ask the trusted branch anything when none is designated', async () => {
    const ask = daemon({ declared: [declaration(CLEANUP, 'b1')] })
    const r = await resolveProjectHooks({ project, resolve: ask })
    expect(ask.calls).toHaveLength(1)
    expect(r.ok && r.hooks.trustRoot).toEqual({ ref: null, configured: false })
  })

  it('reports a daemon that could not answer, rather than an empty tree', async () => {
    const r = await resolveProjectHooks({
      project,
      resolve: (async () => ({
        ok: false,
        error: 'no daemon connected for this project',
        status: 503,
      })) as never as typeof import('./daemon').requestHooksResolution,
    })
    expect(r).toEqual({
      ok: false,
      error: 'no daemon connected for this project',
      status: 503,
    })
  })
})

describe('revokeHookPairs', () => {
  // Withdrawing removes a human's approval and nothing else: the pair may also be
  // on the trusted branch, and that permission came from the branch.
  it('removes a content approval and leaves a cached trust-root one', async () => {
    await approveHookPairs(file, [{ path: CLEANUP, blob: 'b1' }], 'content', { at: AT })
    await approveHookPairs(file, [{ path: CLEANUP, blob: 'b1' }], 'trust-root', {
      ref: 'origin/main',
      at: AT,
    })
    await revokeHookPairs(file, [{ path: CLEANUP, blob: 'b1' }])
    const store = await readHooksStore(file)
    expect(store.approved).toEqual([
      { path: CLEANUP, blob: 'b1', via: 'trust-root', ref: 'origin/main', at: AT },
    ])
  })

  it('leaves other versions of the same path alone', async () => {
    await approveHookPairs(
      file,
      [
        { path: CLEANUP, blob: 'b1' },
        { path: CLEANUP, blob: 'b2' },
      ],
      'content',
      { at: AT },
    )
    await revokeHookPairs(file, [{ path: CLEANUP, blob: 'b2' }])
    expect((await readHooksStore(file)).approved.map((e) => e.blob)).toEqual(['b1'])
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
