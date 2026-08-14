// What `loadShownTasks` asks the server for. The summary projection is opt-in
// per call (see server/tasks.ts taskSummary), so which callers opt in is the
// whole safety property of the change — and the interesting half of it is a
// negative: the *displayed* list must keep fetching whole records, because the
// conversation is what feeds `latestUpdateAt`, the unread dots and the open
// task's pane. A summary reaching that caller is silent, not loud: `items` and
// `rides` are optional on `Task` (src/types.ts), so nothing throws and nothing
// fails to typecheck — the dots just stop appearing. Hence a test on the URL.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadShownTasks } from './api'

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
    // The link poll's archived half sends both on every ten-second cycle. A
    // second `?` would leave the server reading neither param: it would answer
    // with the full *active* list, so mentions of archived tasks would stop
    // resolving to titles and the saving would silently disappear.
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
