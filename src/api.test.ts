// What `loadShownTasks` asks the server for. The summary projection is opt-in
// per call (see server/tasks.ts taskSummary), so which callers opt in is the
// whole safety property of the change — and the interesting half of it is a
// negative: the *displayed* list must keep fetching whole records, because the
// conversation is what feeds `latestUpdateAt`, the unread dots and the open
// task's pane. A summary reaching that caller is silent, not loud: `items` and
// `rides` are optional on `Task` (src/types.ts), so nothing throws and nothing
// fails to typecheck — the dots just stop appearing. Hence a test on the URL.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadShownTasks, loadTaskLinks } from './api'

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
  it('fetches whole records by default, and when summary is explicitly off', async () => {
    // The guard on src/useTaskData.ts's displayed-list poll, which passes no
    // options: were the parameter ever defaulted on, or added at that call
    // site, this is what would go red.
    await loadShownTasks(['p'], false)
    await loadShownTasks(['p'], false, {})
    await loadShownTasks(['p'], false, { summary: false })
    expect(seen).toEqual(['/api/p/tasks', '/api/p/tasks', '/api/p/tasks'])
  })

  it('keeps archived whole too, by default', async () => {
    await loadShownTasks(['p'], true)
    expect(seen).toEqual(['/api/p/tasks?archived=1'])
  })

  it('asks for summaries when the caller opts in', async () => {
    await loadShownTasks(['p'], false, { summary: true })
    expect(seen).toEqual(['/api/p/tasks?view=summary'])
  })

  it('composes both params with one ? and one &', async () => {
    // Summary remains a supported metadata-only caller even though task-link
    // resolution now uses the smaller installation-wide endpoint.
    await loadShownTasks(['p'], true, { summary: true })
    expect(seen).toEqual(['/api/p/tasks?archived=1&view=summary'])
  })

  it('applies the same query to every shown project', async () => {
    await loadShownTasks(['a', 'b'], true, { summary: true })
    expect(seen.sort()).toEqual([
      '/api/a/tasks?archived=1&view=summary',
      '/api/b/tasks?archived=1&view=summary',
    ])
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
                status: 'resting',
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
    expect(fetcher).toHaveBeenCalledWith('/api/p/tasks', {
      signal: expect.any(AbortSignal),
    })
  })

  it('names the request and the bound when the timeout trips', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new DOMException('signal timed out', 'TimeoutError')
    })
    await expect(loadShownTasks(['p'], false)).rejects.toThrow(
      'no response from /api/p/tasks within 30s',
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
