import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadShownTasks, loadTask, loadTaskLinks } from './api'

let seen: string[]

beforeEach(() => {
  seen = []
  vi.stubGlobal('fetch', async (url: string) => {
    seen.push(String(url))
    return { ok: true, json: async () => ({ tasks: [], telemetry: {} }) }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('loadShownTasks request composition', () => {
  it('asks for summaries, of the archived pool when told to', async () => {
    await loadShownTasks(['p'], false)
    await loadShownTasks(['p'], true)
    expect(seen).toEqual(['/api/p/tasks?view=summary', '/api/p/tasks?archived=1&view=summary'])
  })

  it('applies the same query to every shown project', async () => {
    await loadShownTasks(['a', 'b'], true)
    expect(seen.sort()).toEqual([
      '/api/a/tasks?archived=1&view=summary',
      '/api/b/tasks?archived=1&view=summary',
    ])
  })

  it("sends a search's query, and each project only its own tasks' limits", async () => {
    await loadShownTasks(['a', 'b'], false, {
      query: 'fix it',
      limits: [
        { projectSlug: 'a', id: 't1', limit: 23 },
        { projectSlug: 'a', id: 't2', limit: 43 },
      ],
    })
    expect(seen.sort()).toEqual([
      '/api/a/tasks?view=summary&q=fix+it&expand=t1%3A23%2Ct2%3A43',
      '/api/b/tasks?view=summary&q=fix+it',
    ])
  })

  it("returns the flows' capabilities the response carries", async () => {
    const flows = { claude: { grants: { task: true, project: false } } }
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ tasks: [], telemetry: {}, flows }),
    }))
    expect((await loadShownTasks(['p'], false)).flows).toEqual(flows)
  })

  it("returns a search's matches keyed by task, or null without one", async () => {
    const match = { count: 1, list: [{ itemId: 'u1', occurrence: 0, snippet: 'x' }] }
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({
        tasks: [],
        telemetry: {},
        search: { query: 'x', matches: { t1: match } },
      }),
    }))
    const { search } = await loadShownTasks(['p'], false, { query: 'x', limits: [] })
    expect(search?.query).toBe('x')
    expect([...search!.matches]).toEqual([['p/t1', match]])

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      json: async () => ({ tasks: [], telemetry: {} }),
    }))
    expect((await loadShownTasks(['p'], false)).search).toBeNull()
  })
})

describe('loadTaskLinks conditional requests', () => {
  it('reads the compact global projection and its validator', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            links: [
              {
                id: 'same',
                projectSlug: 'other',
                title: 'Elsewhere',
                status: 'paced',
                archived: false,
              },
            ],
          }),
          { status: 200, headers: { etag: '"epoch-1"' } },
        ),
      ),
    )
    const response = await loadTaskLinks()
    expect(response).toMatchObject({
      notModified: false,
      etag: '"epoch-1"',
      links: [{ projectSlug: 'other', id: 'same' }],
    })
  })

  it('sends If-None-Match and accepts a bodyless 304', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 304 }))
    vi.stubGlobal('fetch', fetcher)
    expect(await loadTaskLinks('"epoch-1"')).toEqual({
      notModified: true,
      etag: '"epoch-1"',
    })
    expect(fetcher).toHaveBeenCalledWith('/api/task-links', {
      headers: { 'if-none-match': '"epoch-1"' },
      signal: expect.any(AbortSignal),
    })
  })
})

// Both poll-shaped reads carry the abort that bounds them, and a bound that
// trips reads as a sentence naming the request — not the DOMException's
// "signal timed out".
describe('read timeouts', () => {
  it('bounds the displayed-list read', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tasks: [], telemetry: {} }),
    }))
    vi.stubGlobal('fetch', fetcher)
    await loadShownTasks(['p'], false)
    expect(fetcher).toHaveBeenCalledWith('/api/p/tasks?view=summary', {
      signal: expect.any(AbortSignal),
    })
  })

  it('names the request and the bound when the timeout trips', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('signal timed out', 'TimeoutError')
    })
    await expect(loadShownTasks(['p'], false)).rejects.toThrow(
      'no response from /api/p/tasks?view=summary within 30s',
    )
    await expect(loadTaskLinks()).rejects.toThrow(
      'no response from /api/task-links within 30s',
    )
  })

  it('passes every other failure through untouched', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(loadShownTasks(['p'], false)).rejects.toThrow('Failed to fetch')
  })
})

// A body that isn't the JSON the route promises. The dev proxy answers a request
// it cannot reach the API server with — every `tsx watch` restart of it — with an
// empty 500, so this is the ordinary shape of a restart seen from the client, and
// it must read as a sentence about the request rather than as JSON.parse's
// "Unexpected end of JSON input".
describe('unreadable bodies', () => {
  const respond = (body: string, init: ResponseInit) =>
    vi.stubGlobal('fetch', async () => new Response(body, init))

  it('names the request and the status when the proxy answers an empty 500', async () => {
    respond('', { status: 500, statusText: 'Internal Server Error' })
    await expect(loadShownTasks(['p'], false)).rejects.toThrow(
      '/api/p/tasks?view=summary failed: HTTP 500 Internal Server Error',
    )
  })

  it('prefers what the server said, when it said anything', async () => {
    respond(JSON.stringify({ error: 'no such project' }), { status: 404 })
    await expect(loadShownTasks(['p'], false)).rejects.toThrow('no such project')
  })

  it('reports a 200 whose body was truncated mid-flight', async () => {
    respond('{"tasks":[{"id":"a"', { status: 200 })
    await expect(loadShownTasks(['p'], false)).rejects.toThrow(
      'unreadable response from /api/p/tasks?view=summary (HTTP 200)',
    )
  })

  // Parsing is not enough: `tasks` is what the caller maps over, and without
  // this the failure surfaces as "Cannot read properties of undefined".
  it('reports a parsed 200 that carries no task list', async () => {
    respond(JSON.stringify({ telemetry: {} }), { status: 200 })
    await expect(loadShownTasks(['p'], false)).rejects.toThrow(
      'unreadable response from /api/p/tasks?view=summary (HTTP 200)',
    )
  })
})

describe('loadTask', () => {
  it('fetches a single task, tags its project, and defaults missing items to []', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: 'arc-1',
            title: 'Archived one',
            status: 'landed',
            createdAt: '2026-01-01T00:00:00.000Z',
            archived: true,
          }),
          { status: 200 },
        ),
      ),
    )
    const loaded = await loadTask('proj', 'arc-1')
    expect(loaded).toMatchObject({
      id: 'arc-1',
      projectSlug: 'proj',
      title: 'Archived one',
      status: 'landed',
      archived: true,
      items: [],
    })
  })

  it('rejects a 200 response that carries no task id', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }))
    await expect(loadTask('proj', 'arc-1')).rejects.toThrow(
      'unreadable response from /api/proj/tasks/arc-1 (HTTP 200)',
    )
  })
})
