import { describe, expect, it } from 'vitest'
import ghReviewRequests from './gh-review-requests'
import type { GitHub } from './github'
import { PermanentCheckError } from './types'

const pr = (repo: string, number: number) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/${repo}/pull/${number}`,
  user: { login: 'alice' },
  repository_url: `https://api.github.com/repos/${repo}`,
})

type World = {
  items: unknown[]
  timelines?: Record<string, unknown[]>
  incomplete?: boolean
  brokenTimeline?: boolean
}

function github(world: World, queries: string[] = []): GitHub {
  return {
    async get(path) {
      if (path === '/user') return { body: { login: 'me' } }
      const timeline = path.match(/^\/repos\/(.+)\/issues\/(\d+)\/timeline/)
      if (timeline) {
        if (world.brokenTimeline) throw new Error('GitHub answered 502')
        return { body: world.timelines?.[`${timeline[1]}#${timeline[2]}`] ?? [] }
      }
      queries.push(decodeURIComponent(path))
      const page = Number(path.match(/page=(\d+)$/)?.[1] ?? 1)
      return {
        body: {
          items: world.items.slice((page - 1) * 100, page * 100),
          incomplete_results: world.incomplete ?? false,
        },
      }
    },
  }
}

function run(world: World, prev?: unknown, args: Record<string, string> = {}, queries?: string[]) {
  return ghReviewRequests.run(
    { cwd: '/repo', signal: new AbortController().signal, github: github(world, queries) },
    args,
    prev,
  )
}

describe('gh-review-requests', () => {
  it('treats the requests already waiting as seen, then fires once for each new one', async () => {
    const world: World = { items: [pr('o/a', 1)] }
    const base = await run(world)
    expect(base.fired).toBe(false)
    expect((await run(world, base.state)).fired).toBe(false)

    world.items = [pr('o/a', 1), pr('o/b', 2)]
    const fired = await run(world, base.state)
    expect(fired).toMatchObject({ fired: true })
    const message = (fired as { message: string }).message
    expect(message).toContain('o/b#2: PR 2 (by alice) https://github.com/o/b/pull/2')
    expect(message).not.toContain('o/a#1')
    expect(message).not.toContain('re-request')
    expect((await run(world, fired.state)).fired).toBe(false)
  })

  it('fires again when a request goes away and comes back, and marks a re-request', async () => {
    const world: World = { items: [pr('o/a', 1)] }
    const base = await run(world, undefined, { existing: 'true' })
    expect(base.fired).toBe(true)
    world.items = []
    const reviewed = await run(world, base.state)
    expect(reviewed.fired).toBe(false)
    world.items = [pr('o/a', 1)]
    world.timelines = {
      'o/a#1': [
        { event: 'review_requested', requested_reviewer: { login: 'me' }, created_at: '2026-11-01T09:00:00Z' },
        { event: 'reviewed', user: { login: 'bob' } },
        { event: 'reviewed', user: { login: 'me' } },
        { event: 'review_requested', requested_reviewer: { login: 'bob' }, created_at: '2026-11-03T09:00:00Z' },
        { event: 'review_requested', requested_reviewer: { login: 'me' }, created_at: '2026-11-04T14:15:00Z' },
      ],
    }
    expect(await run(world, reviewed.state)).toMatchObject({
      fired: true,
      message: expect.stringContaining(
        'o/a#1: PR 1 (by alice) https://github.com/o/a/pull/1 — a re-request at 2026-11-04T14:15:00.000Z; you reviewed this PR before',
      ),
    })
  })

  it('gives the time of a first request, including one made to your team', async () => {
    const world: World = {
      items: [pr('o/a', 1)],
      timelines: {
        'o/a#1': [
          { event: 'review_requested', requested_team: { slug: 'web' }, created_at: '2026-11-04T08:00:00Z' },
        ],
      },
    }
    expect(await run(world, undefined, { existing: 'true' })).toMatchObject({
      fired: true,
      message: expect.stringContaining('— requested at 2026-11-04T08:00:00.000Z'),
    })
  })

  it('keeps its last state when GitHub answers with partial results', async () => {
    const world: World = { items: [pr('o/a', 1), pr('o/b', 2)] }
    const base = await run(world)
    world.items = [pr('o/b', 2)]
    world.incomplete = true
    const partial = await run(world, base.state)
    expect(partial).toEqual({ fired: false, state: base.state })
    world.items = [pr('o/a', 1), pr('o/b', 2)]
    world.incomplete = false
    expect((await run(world, partial.state)).fired).toBe(false)
  })

  it('reads every page of results', async () => {
    const world: World = { items: Array.from({ length: 150 }, (_, i) => pr('o/a', i + 1)) }
    const base = await run(world)
    expect((base.state as { requested: string[] }).requested).toHaveLength(150)
  })

  it('still reports a request when its timeline cannot be read', async () => {
    const world: World = { items: [pr('o/a', 1)], brokenTimeline: true }
    expect(await run(world, undefined, { existing: 'true' })).toMatchObject({
      fired: true,
      message: 'Review requests:\n- o/a#1: PR 1 (by alice) https://github.com/o/a/pull/1',
    })
  })

  it('narrows the search by org, repo, and direct requests', async () => {
    const queries: string[] = []
    await run({ items: [] }, undefined, { org: 'acme' }, queries)
    await run({ items: [] }, undefined, { repo: 'acme/app', direct: 'true' }, queries)
    expect(queries[0]).toContain('is:pr is:open review-requested:me org:acme')
    expect(queries[1]).toContain('user-review-requested:me repo:acme/app')
  })

  it('refuses a malformed repo', async () => {
    await expect(run({ items: [] }, undefined, { repo: 'nope' })).rejects.toBeInstanceOf(
      PermanentCheckError,
    )
  })
})
