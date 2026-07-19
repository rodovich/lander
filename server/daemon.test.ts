import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import {
  attachDaemonServer,
  sendToDaemon,
  openRunChannel,
  closeRunChannel,
  requestResume,
  requestProjectGrant,
  daemonConnected,
  daemonServes,
} from './daemon'
import type { RunEvent } from './daemon'
import type { FlowAnnouncement, ServerToDaemon } from './protocol'
import {
  announcedFlows,
  clearAnnouncedFlows,
  isAnnouncedFlow,
} from './flows'

// Integration test for the daemon ⇄ server transport's drain-handoff, driving the
// real attachDaemonServer over real WebSockets with stand-in daemons. The logic
// under test is purely server-side routing, so no real agent child is needed.
//
// The key invariant: a run is only ever resumed on the daemon that actually holds
// it (announced via `register.runs`), and is crashed only when no connected daemon
// claims it. That's what lets a daemon drain across a concurrent server reload —
// it drops, reconnects, re-announces its run, and reclaims it — instead of the run
// being handed to (and aborted by) a fresh daemon that never had it.

const TOKEN = 'test-token'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (pred()) return
    await delay(5)
  }
  throw new Error('waitFor timed out')
}

type RegisterOpts = {
  draining?: boolean
  runs?: string[]
  flows?: FlowAnnouncement[]
}

type FakeDaemon = {
  received: ServerToDaemon[]
  register: (opts?: RegisterOpts) => void
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
        register: ({ draining = false, runs = [], flows }: RegisterOpts = {}) =>
          ws.send(
            JSON.stringify({
              type: 'register',
              projects: [{ slug: 'proj' }],
              draining,
              runs,
              // Omitted entirely when not given — that IS the old-daemon case.
              ...(flows ? { flows } : {}),
            }),
          ),
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
  agent: 'claude',
  project: 'proj',
  prompt: 'prompt',
  task: {
    allowEdits: false,
  },
  env: {},
  idleTimeoutMs: 0,
})

// Resolve the next channel event, or null if none arrives within `ms` — lets us
// assert that a run was *not* crashed.
function nextOrNull(
  channel: { next: () => Promise<RunEvent> },
  ms = 100,
): Promise<RunEvent | null> {
  return Promise.race([
    channel.next(),
    delay(ms).then(() => null),
  ])
}

let http: Server
let port: number

describe('daemon transport handoff', () => {
  beforeAll(async () => {
    http = createServer()
    attachDaemonServer(http, { token: TOKEN })
    await new Promise<void>((r) => http.listen(0, r))
    port = (http.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((r) => http.close(() => r()))
  })

  it('routes new runs to the new primary; control follows the owning daemon', async () => {
    expect(daemonConnected()).toBe(false)

    // Daemon A connects and registers (holding no runs) — it's the primary.
    const a = await connectDaemon(port)
    a.register()
    await waitFor(() => daemonServes('proj'))
    expect(daemonConnected()).toBe(true)

    // r1 starts: it goes to A, and A is recorded as its owner.
    const ch1 = openRunChannel('r1')
    expect(sendToDaemon(start('r1'))).toBe(true)
    await waitFor(() => a.has('start-run', 'r1'))

    // Inbound routing is by runId: A's update reaches r1's channel.
    a.send({ type: 'update', runId: 'r1', seq: 1, steps: [], usageChanged: false })
    expect(await ch1.next()).toMatchObject({ kind: 'update', msg: { runId: 'r1', seq: 1 } })

    // Daemon B connects and registers holding nothing → it's the new primary. It
    // must NOT be told to resume r1, which A still owns.
    const b = await connectDaemon(port)
    b.register()
    await waitFor(() => daemonServes('proj'))
    await delay(50)
    expect(b.has('resume-from', 'r1')).toBe(false)

    // A new run goes to the new primary B — not A.
    const ch2 = openRunChannel('r2')
    expect(sendToDaemon(start('r2'))).toBe(true)
    await waitFor(() => b.has('start-run', 'r2'))
    expect(a.has('start-run', 'r2')).toBe(false)

    // Control for r1 follows ownership to A — never the non-owner B.
    sendToDaemon({ type: 'interrupt', runId: 'r1' })
    await waitFor(() => a.has('interrupt', 'r1'))
    requestResume('r1')
    await waitFor(
      () =>
        a.received.filter(
          (m) => m.type === 'resume-from' && (m as { runId?: string }).runId === 'r1',
        ).length >= 1,
    )
    expect(b.has('resume-from', 'r1')).toBe(false)

    closeRunChannel('r1')
    closeRunChannel('r2')
    await a.close()
    await b.close()
    await waitFor(() => !daemonConnected())
  })

  it('lets a draining daemon drop and reconnect to reclaim its run (server-reload-during-drain)', async () => {
    // A is primary and starts r3.
    const a = await connectDaemon(port)
    a.register()
    await waitFor(() => daemonServes('proj'))
    const ch3 = openRunChannel('r3')
    expect(sendToDaemon(start('r3'))).toBe(true)
    await waitFor(() => a.has('start-run', 'r3'))

    // A fresh daemon B takes over as primary (the handoff). It holds no runs.
    const b = await connectDaemon(port)
    b.register()
    await waitFor(() => daemonServes('proj'))

    // The link to the draining A drops (e.g. a concurrent server reload). Its run
    // r3 is now unowned — but it must NOT be reassigned to B, which never had it.
    await a.close()
    await delay(20)
    expect(b.has('resume-from', 'r3')).toBe(false)

    // The draining A reconnects and re-announces r3. The server hands r3 back to
    // it (resume-from) — the run is reclaimed, not aborted, and never went to B.
    const a2 = await connectDaemon(port)
    a2.register({ draining: true, runs: ['r3'] })
    await waitFor(() => a2.has('resume-from', 'r3'))
    expect(b.has('resume-from', 'r3')).toBe(false)

    // r3 finishes on the reconnected A: its done reaches the channel, with no
    // crash ever synthesized in between.
    a2.send({ type: 'done', runId: 'r3', exitCode: 0, interrupted: false, stderr: '' })
    expect(await nextOrNull(ch3)).toMatchObject({ kind: 'done', msg: { runId: 'r3' } })

    closeRunChannel('r3')
    await a2.close()
    await b.close()
    await waitFor(() => !daemonConnected())
  })

  it('routes project grant requests to the primary daemon and resolves its result', async () => {
    const d = await connectDaemon(port)
    d.register()
    await waitFor(() => daemonServes('proj'))

    const result = requestProjectGrant({
      project: 'proj',
      agent: 'codex',
      flow: 'codex',
      rule: 'Bash(npm test)',
      timeoutMs: 1000,
    })
    await waitFor(() => d.received.some((m) => m.type === 'project-grant'))
    const req = d.received.find((m) => m.type === 'project-grant')
    expect(req).toMatchObject({
      type: 'project-grant',
      project: 'proj',
      agent: 'codex',
      rule: 'Bash(npm test)',
    })
    d.send({
      type: 'project-grant-result',
      requestId: req && 'requestId' in req ? req.requestId : '',
      ok: false,
      error: 'unsupported',
      status: 400,
    })

    await expect(result).resolves.toEqual({
      ok: false,
      error: 'unsupported',
      status: 400,
    })

    await d.close()
    await waitFor(() => !daemonConnected())
  })
})

// The flow registry's transport half: who may write it, when it is written
// relative to the slug set, and what clears it. These are what make C6's
// dispatch gate a real invariant rather than a hint — a registry that could go
// stale in the "announces more than the daemon can run" direction would let a
// task be dispatched to a daemon that cannot drive it.

const flowAnn = (name: string): FlowAnnouncement => ({
  scope: 'bundled',
  meta: {
    api: 1,
    name,
    description: `the ${name} flow`,
    driver: true,
    capabilities: {
      worktrees: false,
      vision: 'read',
      grants: { task: false, project: false },
      usageSnapshot: false,
      rateLimitRetry: false,
      reportsCost: false,
    },
  },
})

describe('flow announcement over the daemon link', () => {
  let http2: Server
  let port2: number
  // What the registry looked like at the instant onRegister fired.
  let seenAtRegister: string[] | null = null

  beforeAll(async () => {
    http2 = createServer()
    attachDaemonServer(http2, {
      token: TOKEN,
      onRegister: () => {
        seenAtRegister = announcedFlows().map((f) => f.meta.name)
      },
    })
    await new Promise<void>((r) => http2.listen(0, r))
    port2 = (http2.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((r) => http2.close(() => r()))
  })

  beforeEach(() => {
    clearAnnouncedFlows()
    seenAtRegister = null
  })

  it('sets the registry BEFORE onRegister fires', async () => {
    // Load-bearing, not decorative: awaitDaemonServing unblocks off the slug
    // set that onRegister reports, so a runTurn released by it must not be able
    // to read a registry that hasn't been written yet. If setAnnouncedFlows
    // moved after the slug loop, this sees [].
    const d = await connectDaemon(port2)
    d.register({ flows: [flowAnn('claude'), flowAnn('open-pr')] })
    await waitFor(() => seenAtRegister !== null)
    expect(seenAtRegister).toEqual(['claude', 'open-pr'])
    await d.close()
  })

  it('treats a register with no flows field as announcing nothing', async () => {
    // The old-daemon and rolled-back-daemon case. It must not inherit whatever
    // the previous primary announced.
    const a = await connectDaemon(port2)
    a.register({ flows: [flowAnn('open-pr')] })
    await waitFor(() => isAnnouncedFlow('open-pr'))

    const b = await connectDaemon(port2)
    b.register() // no `flows` key at all — a daemon built before the field
    await waitFor(() => !isAnnouncedFlow('open-pr'))
    expect(announcedFlows()).toEqual([])

    await a.close()
    await b.close()
  })

  it('does not let a draining daemon overwrite the live registry', async () => {
    // A draining daemon is not the primary, and the registry describes what the
    // primary can run. Letting a handoff's outgoing half write here would
    // announce the wrong capability set mid-drain.
    const primary = await connectDaemon(port2)
    primary.register({ flows: [flowAnn('open-pr')] })
    await waitFor(() => isAnnouncedFlow('open-pr'))

    const draining = await connectDaemon(port2)
    draining.register({ draining: true, flows: [flowAnn('something-else')] })
    await delay(50)
    expect(isAnnouncedFlow('open-pr')).toBe(true)
    expect(isAnnouncedFlow('something-else')).toBe(false)

    await primary.close()
    await draining.close()
  })

  it('clears the registry when the primary drops, but not a non-primary', async () => {
    const primary = await connectDaemon(port2)
    primary.register({ flows: [flowAnn('open-pr')] })
    await waitFor(() => isAnnouncedFlow('open-pr'))

    // A draining non-primary disconnecting is the normal end of a handoff — it
    // must not take the live daemon's announcement with it.
    const draining = await connectDaemon(port2)
    draining.register({ draining: true })
    await draining.close()
    await delay(50)
    expect(isAnnouncedFlow('open-pr')).toBe(true)

    await primary.close()
    await waitFor(() => !isAnnouncedFlow('open-pr'))
  })
})
