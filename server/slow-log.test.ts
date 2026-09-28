import { describe, it, expect, vi, afterEach } from 'vitest'
import { Hono } from 'hono'
import { createSlowLog, SLOW_REQUEST_MS } from './slow-log'

// A clock the test moves by hand, so "slow" needs no real waiting.
function setup() {
  let t = 0
  const lines: string[] = []
  const log = createSlowLog((l) => lines.push(l), () => t)
  const app = new Hono()
  app.use('*', log.middleware)
  let release: () => void = () => {}
  app.get('/fast', (c) => c.text('ok'))
  app.get('/slow', (c) => {
    t += SLOW_REQUEST_MS + 500
    return c.json({ error: 'nope' }, 500)
  })
  app.get('/hang', async (c) => {
    await new Promise<void>((r) => (release = r))
    return c.text('late')
  })
  return {
    log,
    app,
    lines,
    advance: (ms: number) => (t += ms),
    release: () => release(),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('slow-request log', () => {
  it('writes nothing for a request under the threshold', async () => {
    const { app, lines } = setup()
    await app.request('/fast')
    expect(lines).toEqual([])
  })

  it('names the method, path, status and duration of a slow request', async () => {
    const { app, lines } = setup()
    await app.request('/slow')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^\S+Z slow request: GET \/slow 500 after 3\.5s$/)
  })

  it('reports a request still hanging, once, before it finishes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const s = setup()
    s.log.start()
    const answered = s.app.request('/hang')

    s.advance(SLOW_REQUEST_MS + 100)
    vi.advanceTimersByTime(500)
    s.advance(500)
    vi.advanceTimersByTime(500)
    expect(s.lines.filter((l) => l.includes('still unanswered'))).toEqual([
      expect.stringMatching(/request still unanswered: GET \/hang after 3\.\ds$/),
    ])

    // When it does finish, the total is logged as well.
    s.release()
    await answered
    expect(s.lines.at(-1)).toMatch(/slow request: GET \/hang 200 after/)
    s.log.stop()
  })

  it('reports the event loop blocked when a tick arrives late', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const s = setup()
    s.log.start()

    s.advance(500)
    vi.advanceTimersByTime(500)
    expect(s.lines).toEqual([])

    // The tick fires 2.5s after the last one instead of 0.5s.
    s.advance(2_500)
    vi.advanceTimersByTime(500)
    expect(s.lines).toEqual([
      expect.stringMatching(/event loop blocked for 2\.0s$/),
    ])
    s.log.stop()
  })
})
