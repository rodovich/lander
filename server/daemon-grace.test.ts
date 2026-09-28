import { describe, it, expect, vi, afterAll } from 'vitest'
import { createServer } from 'node:http'
import {
  attachDaemonServer,
  closeRunChannel,
  openRunChannel,
  requestResume,
} from './daemon'
import type { RunEvent } from './daemon'

// The reconnect grace must count only while a daemon could actually reconnect.
// Boot recovery reattaches runs (requestResume) before serve() binds; if the bind
// is slow, a grace armed at reattach time could lapse with the /daemon endpoint
// never having existed, crashing runs whose daemon was alive and holding them.
// Its own file because daemon.ts keeps module state, and this needs it fresh:
// no endpoint attached, nothing listening yet.

// One standing next() for the whole test, recording what arrives. Polling with
// fresh next() calls would not work: each unanswered call installs the channel's
// waiter, and the event would go to a waiter nobody is still reading.
function watch(ch: { next: () => Promise<RunEvent> }) {
  let got: RunEvent | null = null
  void ch.next().then((e) => (got = e))
  return () => got
}

describe('reconnect grace at boot', () => {
  const http = createServer()
  afterAll(async () => {
    vi.useRealTimers()
    await new Promise<void>((r) => http.close(() => r()))
  })

  it('starts counting when the endpoint listens, not when recovery reattaches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const received = watch(openRunChannel('boot-run'))

    // Recovery reattaches before the server exists: no daemon owns the run.
    requestResume('boot-run')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(received()).toBeNull()

    // Attached but still not bound — the slow-bind window that used to kill runs.
    attachDaemonServer(http, { token: 'test-token' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(received()).toBeNull()

    // Bound: from here a daemon could reconnect, so the full grace applies.
    await new Promise<void>((r) => http.listen(0, r))
    await vi.advanceTimersByTimeAsync(14_000)
    expect(received()).toBeNull()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(received()).toEqual({ kind: 'crashed' })

    closeRunChannel('boot-run')
  })
})
