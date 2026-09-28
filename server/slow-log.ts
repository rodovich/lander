import type { MiddlewareHandler } from 'hono'
import type { ServerResponse } from 'node:http'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

// A record of the API being slow, written where a task can read it afterwards.
// The dev terminal is the only other log, and it is neither readable from a task
// nor reliable: on 2026-09-28 the tasks poll timed out in the browser for minutes
// and nothing on disk could say whether this server, the Vite proxy in front of
// it, or the browser was the one stalling. Only slow things are written, so the
// file stays empty while all is well.
//
// Three signals, because a stall hides from any one of them:
// - a request that finished slowly (or whose client gave up on it first);
// - a request still unanswered past the threshold, reported while it hangs —
//   one that never finishes would otherwise never be logged at all;
// - the event loop blocked, which delays everything, including the two above.

export const SLOW_REQUEST_MS = 3_000
export const LOOP_BLOCKED_MS = 1_000
const TICK_MS = 500

type Pending = { method: string; path: string; start: number; reported: boolean }

export type SlowLog = {
  // Hono middleware timing each request. Register before any route.
  middleware: MiddlewareHandler
  // Begin the periodic checks for hung requests and a blocked event loop.
  start: () => void
  stop: () => void
}

// `write` receives each finished line; `now` is injectable for tests.
export function createSlowLog(
  write: (line: string) => void,
  now: () => number = () => performance.now(),
): SlowLog {
  const pending = new Set<Pending>()
  let timer: ReturnType<typeof setInterval> | null = null
  let lastTick = 0

  const log = (text: string) => write(`${new Date().toISOString()} ${text}`)
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`

  const settle = (p: Pending, status: number | 'aborted') => {
    if (!pending.delete(p)) return
    const ms = now() - p.start
    if (ms < SLOW_REQUEST_MS) return
    const outcome =
      status === 'aborted' ? 'closed by the client before the answer' : status
    log(`slow request: ${p.method} ${p.path} ${outcome} after ${secs(ms)}`)
  }

  const middleware: MiddlewareHandler = async (c, next) => {
    const p: Pending = {
      method: c.req.method,
      path: c.req.path,
      start: now(),
      reported: false,
    }
    pending.add(p)
    // Under @hono/node-server the Node response is on the env, and its `close`
    // marks the true end: the body sent, or the client gone. Without it (tests,
    // other adapters) the handler's return is the best end there is.
    const res = (c.env as { outgoing?: ServerResponse } | undefined)?.outgoing
    if (res) {
      res.once('close', () =>
        settle(p, res.writableFinished ? res.statusCode : 'aborted'),
      )
      await next()
    } else {
      try {
        await next()
      } finally {
        settle(p, c.res.status)
      }
    }
  }

  const tick = () => {
    const t = now()
    const late = t - lastTick - TICK_MS
    lastTick = t
    if (late >= LOOP_BLOCKED_MS) log(`event loop blocked for ${secs(late)}`)
    for (const p of pending) {
      const ms = t - p.start
      if (p.reported || ms < SLOW_REQUEST_MS) continue
      p.reported = true
      log(`request still unanswered: ${p.method} ${p.path} after ${secs(ms)}`)
    }
  }

  return {
    middleware,
    start() {
      if (timer) return
      lastTick = now()
      timer = setInterval(tick, TICK_MS)
      timer.unref()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

// Append to `file`, creating its directory, and echo to the terminal. A failed
// write is dropped: the log must never be what breaks a request.
export function fileWriter(file: string): (line: string) => void {
  const ready = mkdir(path.dirname(file), { recursive: true }).catch(() => {})
  return (line) => {
    console.warn(line)
    void ready.then(() => appendFile(file, line + '\n').catch(() => {}))
  }
}
