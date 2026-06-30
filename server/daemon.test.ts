import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import {
  attachDaemonServer,
  sendToDaemon,
  openRunChannel,
  closeRunChannel,
  requestResume,
  daemonConnected,
  daemonServes,
} from './daemon'
import type { ServerToDaemon } from './protocol'

// Integration test for the daemon ⇄ server transport's drain-handoff: a fresh
// daemon connecting becomes the primary (new runs go to it) while a still-connected
// predecessor keeps and finishes the runs it owns. We drive the real
// attachDaemonServer over real WebSockets with two simulated daemons and assert
// where each control message lands — no real claude child is needed, since the
// logic under test is purely the server-side routing in daemon.ts.

const TOKEN = 'test-token'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Poll until `pred` holds (server-side state and WS delivery are both async).
async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (pred()) return
    await delay(5)
  }
  throw new Error('waitFor timed out')
}

// A stand-in daemon: records every frame the server sends it, and can push
// daemon→server frames back.
type FakeDaemon = {
  received: ServerToDaemon[]
  send: (m: object) => void
  close: () => Promise<void>
  has: (type: string, runId: string) => boolean
}

function connectDaemon(port: number): Promise<FakeDaemon> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/daemon?token=${TOKEN}`)
    const received: ServerToDaemon[] = []
    ws.on('message', (d) => {
      try {
        received.push(JSON.parse(d.toString()) as ServerToDaemon)
      } catch {
        // ignore non-JSON
      }
    })
    ws.on('error', reject)
    ws.on('open', () =>
      resolve({
        received,
        send: (m) => ws.send(JSON.stringify(m)),
        has: (type, runId) =>
          received.some(
            (m) => m.type === type && (m as { runId?: string }).runId === runId,
          ),
        close: () =>
          new Promise<void>((res) => {
            ws.on('close', () => res())
            ws.close()
          }),
      }),
    )
  })
}

const start = (runId: string): ServerToDaemon => ({
  type: 'start-run',
  runId,
  taskId: `task-${runId}`,
  project: 'proj',
  claudeArgs: [],
  env: {},
  idleTimeoutMs: 0,
})

let http: Server
let port: number

describe('daemon transport handoff', () => {
  afterAll(async () => {
    await new Promise<void>((r) => http.close(() => r()))
  })

  it('routes new runs to the new primary and keeps a draining predecessor on its own runs', async () => {
    http = createServer()
    attachDaemonServer(http, { token: TOKEN })
    await new Promise<void>((r) => http.listen(0, r))
    port = (http.address() as AddressInfo).port

    expect(daemonConnected()).toBe(false)

    // Daemon A connects and registers; it's the only daemon, so it's primary.
    const a = await connectDaemon(port)
    a.send({ type: 'register', projects: [{ slug: 'proj' }] })
    await waitFor(() => daemonServes('proj'))
    expect(daemonConnected()).toBe(true)

    // r1 starts: it goes to A, and A is recorded as its owner.
    const ch1 = openRunChannel('r1')
    expect(sendToDaemon(start('r1'))).toBe(true)
    await waitFor(() => a.has('start-run', 'r1'))

    // Inbound routing is by runId (daemon-agnostic): A's update reaches r1's channel.
    a.send({ type: 'update', runId: 'r1', seq: 1, steps: [], usageChanged: false })
    expect(await ch1.next()).toMatchObject({ kind: 'update', msg: { runId: 'r1', seq: 1 } })

    // Daemon B connects → it becomes primary. It must NOT be asked to resume r1,
    // because the live predecessor A still owns it.
    const b = await connectDaemon(port)
    b.send({ type: 'register', projects: [{ slug: 'proj' }] })
    await waitFor(() => daemonServes('proj'))
    await delay(50) // let any (erroneous) resume-from arrive before asserting its absence
    expect(b.has('resume-from', 'r1')).toBe(false)

    // A new run goes to the new primary B — not the draining A.
    const ch2 = openRunChannel('r2')
    expect(sendToDaemon(start('r2'))).toBe(true)
    await waitFor(() => b.has('start-run', 'r2'))
    expect(a.has('start-run', 'r2')).toBe(false)

    // Control for r1 follows ownership to A (interrupt + an explicit resume), not B.
    sendToDaemon({ type: 'interrupt', runId: 'r1' })
    await waitFor(() => a.has('interrupt', 'r1'))
    requestResume('r1')
    await waitFor(() => a.received.filter((m) => m.type === 'resume-from' && (m as { runId?: string }).runId === 'r1').length >= 1)
    expect(b.has('resume-from', 'r1')).toBe(false)

    // When the draining A drops, its orphaned r1 is handed to the live primary B
    // (which will replay or abort it) — the run isn't left hanging.
    await a.close()
    await waitFor(() => b.has('resume-from', 'r1'))

    // Teardown: close channels first so the last daemon's drop finds nothing open
    // (no crash-grace timer armed), then drop B and confirm no daemon remains.
    closeRunChannel('r1')
    closeRunChannel('r2')
    await b.close()
    await waitFor(() => daemonConnected() === false)
  })
})
