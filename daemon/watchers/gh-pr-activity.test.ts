import { afterEach, describe, expect, it, vi } from 'vitest'
import ghPrActivity from './gh-pr-activity'
import { createGitHub, type GitHub } from './github'
import { PermanentWatcherError } from './types'

const PR = '/repos/o/r/pulls/7'
const TIMELINE = '/repos/o/r/issues/7/timeline?per_page=100&page=1'
const T0 = '2026-11-03T10:00:00.000Z'

type Fake = {
  author: string
  state?: string
  merged?: boolean
  sha: string
  events: Record<string, unknown>[]
}

function github(world: Fake): GitHub {
  return {
    async get(path) {
      if (path === '/user') return { body: { login: 'me' } }
      if (path === PR)
        return {
          body: {
            state: world.state ?? 'open',
            merged: world.merged ?? false,
            merged_by: world.merged ? { login: world.author } : null,
            user: { login: world.author },
            head: { sha: world.sha },
            html_url: 'https://github.com/o/r/pull/7',
          },
        }
      if (path === TIMELINE) return { body: world.events }
      throw new Error(`unexpected ${path}`)
    },
  }
}

function run(world: Fake, prev?: unknown, args: Record<string, string> = {}) {
  return ghPrActivity.run(
    { cwd: '/repo', signal: new AbortController().signal, github: github(world) },
    { pr: 'o/r#7', ...args },
    prev,
  )
}

const comment = (login: string, at: string, id: number, type = 'User') => ({
  event: 'commented',
  id,
  actor: { login, type },
  created_at: at.replace('.000', ''),
  html_url: `https://github.com/o/r/pull/7#c${id}`,
})

const reply = (login: string, at: string, id: number) => ({
  event: 'reviewed',
  id,
  user: { login },
  state: 'commented',
  submitted_at: at,
  html_url: `https://github.com/o/r/pull/7#r${id}`,
})

function later(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

async function settle(world: Fake, prev: unknown, runs = 3) {
  let state = prev
  for (let i = 0; i < runs; i++) {
    const r = await run(world, state)
    if (r.fired) return r
    state = r.state
  }
  return undefined
}

describe('gh-pr-activity while reviewing someone else’s PR', () => {
  it('fires on the author’s response once it settles, and ignores other people and bots', async () => {
    const world: Fake = { author: 'alice', sha: 'a1', events: [] }
    const base = await run(world)
    expect(base.fired).toBe(false)

    world.events = [comment('bob', later(1), 1), comment('dependabot', later(1), 2, 'Bot')]
    const others = await run(world, base.state)
    expect(others.fired).toBe(false)
    expect((await run(world, others.state)).fired).toBe(false)

    world.events.push(comment('alice', later(2), 3))
    const first = await run(world, others.state)
    expect(first.fired).toBe(false)
    const settled = await run(world, first.state)
    expect(settled).toMatchObject({ fired: true })
    const message = (settled as { message: string }).message
    expect(message).toContain('alice commented')
    expect(message).not.toContain('bob')
    expect(message).toContain('gh pr diff 7 --repo o/r')
  })

  it('counts commits pushed with no comment, once they settle', async () => {
    const world: Fake = { author: 'alice', sha: 'a1', events: [] }
    const base = await run(world)
    world.sha = 'b2c3d4e5'
    const fired = await settle(world, base.state)
    expect(fired?.message).toContain('head is now b2c3d4e')
  })

  it('waits for a reply that follows a push, rather than reporting the push alone', async () => {
    const world: Fake = { author: 'alice', sha: 'a1', events: [] }
    const base = await run(world)
    world.sha = 'b2c3d4e5'
    const pushed = await run(world, base.state)
    expect(pushed.fired).toBe(false)
    world.events = [reply('alice', later(1), 5)]
    const replied = await run(world, pushed.state)
    expect(replied.fired).toBe(false)
    const fired = await run(world, replied.state)
    expect(fired).toMatchObject({ fired: true })
    expect((fired as { message: string }).message).toMatch(/head is now b2c3d4e[\s\S]*alice reviewed/)
  })

  it('counts an event GitHub stamps earlier than ones already seen', async () => {
    const world: Fake = { author: 'alice', sha: 'a1', events: [] }
    const base = await run(world)
    world.events = [comment('alice', later(5), 1)]
    const fired = await settle(world, base.state)
    world.events.push(reply('alice', later(2), 2))
    expect((await settle(world, fired!.state))?.message).toContain('alice reviewed')
  })

  it('fires at once when the author re-requests your review', async () => {
    const world: Fake = { author: 'alice', sha: 'a1', events: [] }
    const base = await run(world)
    world.events = [
      comment('alice', later(1), 1),
      {
        event: 'review_requested',
        id: 9,
        actor: { login: 'alice' },
        requested_reviewer: { login: 'me' },
        created_at: later(2),
      },
    ]
    const r = await run(world, base.state)
    expect(r.fired).toBe(true)
    const message = (r as { message: string }).message
    expect(message).toContain('alice requested your review')
    expect(message).toContain('alice commented')
  })

  it('reports a response still settling along with the merge that follows it', async () => {
    const world: Fake = { author: 'alice', sha: 'a1', events: [] }
    const base = await run(world)
    world.events = [reply('alice', later(1), 5)]
    const replied = await run(world, base.state)
    expect(replied.fired).toBe(false)
    world.state = 'closed'
    world.merged = true
    const merged = await run(world, replied.state)
    expect((merged as { message: string }).message).toMatch(/alice reviewed[\s\S]*merged by alice/)
  })

  it('reports a response that keeps growing after a few runs rather than waiting forever', async () => {
    const world: Fake = { author: 'alice', sha: 'a1', events: [] }
    let state = (await run(world)).state
    for (let i = 1; i <= 3; i++) {
      world.events.push(comment('alice', later(i), i))
      const r = await run(world, state)
      expect(r.fired).toBe(false)
      state = r.state
    }
    world.events.push(comment('alice', later(4), 4))
    const fired = await run(world, state)
    expect(fired.fired).toBe(true)
    expect((fired as { message: string }).message.match(/alice commented/g)).toHaveLength(4)
  })

  it('fires at once when the PR merges or closes', async () => {
    const world: Fake = { author: 'alice', sha: 'a1', events: [] }
    const base = await run(world)
    world.state = 'closed'
    world.merged = true
    expect(await run(world, base.state)).toMatchObject({
      fired: true,
      message: expect.stringContaining('merged by alice'),
    })
  })

  it('counts activity since a given time on its first run', async () => {
    const world: Fake = {
      author: 'alice',
      sha: 'a1',
      events: [comment('alice', '2026-11-03T10:05:00.000Z', 1)],
    }
    expect(await settle(world, undefined)).toBeUndefined()
    const sinceRun = await run(world, undefined, { since: T0 })
    expect(sinceRun.fired).toBe(false)
    expect(await run(world, sinceRun.state, { since: T0 })).toMatchObject({ fired: true })
  })

  it('reports the same event only once', async () => {
    const world: Fake = { author: 'alice', sha: 'a1', events: [] }
    const base = await run(world)
    world.events = [comment('alice', later(1), 1)]
    const fired = await settle(world, base.state)
    expect(fired?.fired).toBe(true)
    expect(await settle(world, fired!.state)).toBeUndefined()
  })
})

describe('gh-pr-activity on your own PR', () => {
  it('counts anyone but you and bots', async () => {
    const world: Fake = { author: 'me', sha: 'a1', events: [] }
    const base = await run(world)
    world.events = [
      comment('me', later(1), 1),
      comment('ci-bot', later(1), 2, 'Bot'),
      comment('carol', later(1), 3),
    ]
    const fired = await settle(world, base.state)
    expect(fired?.message).toContain('carol commented')
    expect(fired?.message).not.toContain('ci-bot')
    expect(fired?.message).not.toContain('me commented')
  })
})

describe('gh-pr-activity arguments', () => {
  it('refuses a malformed PR reference or from', async () => {
    const world: Fake = { author: 'alice', sha: 'a1', events: [] }
    await expect(
      ghPrActivity.run(
        { cwd: '/repo', signal: new AbortController().signal, github: github(world) },
        { pr: 'not a pr' },
        undefined,
      ),
    ).rejects.toBeInstanceOf(PermanentWatcherError)
    await expect(run(world, undefined, { from: 'everyone' })).rejects.toBeInstanceOf(
      PermanentWatcherError,
    )
  })

  it('accepts a PR URL', async () => {
    const world: Fake = { author: 'alice', sha: 'a1', events: [] }
    const r = await ghPrActivity.run(
      { cwd: '/repo', signal: new AbortController().signal, github: github(world) },
      { pr: 'https://github.com/o/r/pull/7' },
      undefined,
    )
    expect(r.fired).toBe(false)
  })
})

describe('createGitHub', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('fetches the token again once when GitHub refuses it', async () => {
    const tokens = ['old', 'new']
    const seen: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).authorization
      seen.push(auth)
      return new Response(auth === 'Bearer new' ? '{"login":"me"}' : '', {
        status: auth === 'Bearer new' ? 200 : 401,
      })
    })
    const gh = createGitHub(async () => tokens.shift()!)
    const res = await gh.get('/user', { signal: new AbortController().signal })
    expect(res.body).toEqual({ login: 'me' })
    expect(seen).toEqual(['Bearer old', 'Bearer new'])
  })

  it('fetches the token again after fetching it failed', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"login":"me"}', { status: 200 }))
    const attempts: string[] = []
    const gh = createGitHub(async () => {
      attempts.push('try')
      if (attempts.length === 1) throw new Error('keychain locked')
      return 't'
    })
    const signal = new AbortController().signal
    await expect(gh.get('/user', { signal })).rejects.toThrow('keychain locked')
    expect((await gh.get('/user', { signal })).body).toEqual({ login: 'me' })
    expect(attempts).toHaveLength(2)
  })

  it('treats a missing resource as permanent', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    const gh = createGitHub(async () => 't')
    await expect(
      gh.get('/repos/o/r/pulls/1', { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(PermanentWatcherError)
  })
})
