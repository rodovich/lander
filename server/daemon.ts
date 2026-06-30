// Server side of the daemon ⇄ server WebSocket link. This module owns the
// transport only: it
// accepts the daemon's connection, routes inbound run messages to the per-run
// channel a reducer is draining, and lets the server push run control back. The
// claude-specific reduction lives daemon-side; the task-mutation consumer lives
// in index.ts (applyUpdate/applyDone). So this file stays import-light — protocol
// types plus `ws` — and carries no task knowledge.

import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import type {
  DaemonToServer,
  ServerToDaemon,
  UpdateMessage,
  DoneMessage,
  SessionMessage,
  UsageBody,
} from './protocol'

// One run's inbound events, delivered in order to the reducer awaiting them. The
// WS message handler pushes; reduceRunWs pulls via `next()`. A `crashed` event is
// synthesized when the daemon disconnects with this run still open, so the
// reducer finalizes the run the same way the file path treats a dead runner.
export type RunEvent =
  | { kind: 'update'; msg: UpdateMessage }
  | { kind: 'done'; msg: DoneMessage }
  | { kind: 'session'; msg: SessionMessage }
  | { kind: 'crashed' }

// A single-consumer async queue: events buffer until pulled, and a pull before
// any event is pending parks until one arrives. One per in-flight WS run.
class RunChannel {
  private queue: RunEvent[] = []
  private waiter: ((e: RunEvent) => void) | null = null
  // The last seq the consumer (reduceRunWs) has applied for this run; the
  // connection manager reads it to tell a (re)connecting daemon where to resume.
  // Seeded from the task's persisted run cursor so a cold restart resumes from
  // exactly what's on disk.
  lastSeq = -1
  push(e: RunEvent): void {
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w(e)
    } else {
      this.queue.push(e)
    }
  }
  next(): Promise<RunEvent> {
    const e = this.queue.shift()
    if (e) return Promise.resolve(e)
    return new Promise((resolve) => {
      this.waiter = resolve
    })
  }
}

// How long to hold an in-flight run open after the daemon drops before giving up
// and crashing it. Covers a brief link blip and a `tsx watch` server reload (the
// daemon survives and reconnects); past it we assume the daemon is gone.
const RECONNECT_GRACE_MS = 15_000

// Daemon connections. Normally one, but a drain-handoff briefly runs two: when a
// daemon is told to drain (it finishes its riding turns and exits — see the dev
// supervisor and the daemon's SIGUSR1 handler), a fresh daemon connects and
// becomes `primary` — the one that receives all new runs — while the draining one
// stays connected to finish the runs it still owns. `runOwner` maps each in-flight
// run to the daemon holding it, so interrupt/resume-from/ack reach the right one
// and the new primary doesn't try to resume a run a draining daemon is finishing.
let primary: WebSocket | null = null
const daemons = new Set<WebSocket>()
const runOwner = new Map<string, WebSocket>()
const registeredSlugs = new Set<string>()
const channels = new Map<string, RunChannel>()
// Armed when no daemon is connected with runs still open: on expiry, if none has
// returned, the open runs are crashed. Cleared when a daemon (re)connects.
let graceTimer: ReturnType<typeof setTimeout> | null = null

export function daemonConnected(): boolean {
  return primary != null
}

export function daemonServes(slug: string): boolean {
  return registeredSlugs.has(slug)
}

// Open the channel a reducer drains for one run. The WS handler routes this
// run's `update`/`done` here by runId; closeRunChannel tears it down when the
// reducer returns.
export function openRunChannel(runId: string): RunChannel {
  const channel = new RunChannel()
  channels.set(runId, channel)
  return channel
}

export function closeRunChannel(runId: string): void {
  channels.delete(runId)
}

// Push a control message to the daemon that owns its run. `start-run` goes to the
// current primary and records it as the run's owner; interrupt/resume-from/ack
// follow that ownership, falling back to the primary for a run we have no owner
// for (e.g. one seeded from disk at boot, before any daemon adopted it). Returns
// false if there's no daemon to take it, so the caller can fall back.
export function sendToDaemon(msg: ServerToDaemon): boolean {
  let target: WebSocket | null
  if (msg.type === 'start-run') {
    target = primary
    if (target) runOwner.set(msg.runId, target)
  } else {
    target = runOwner.get(msg.runId) ?? primary
  }
  if (!target) return false
  target.send(JSON.stringify(msg))
  return true
}

// Arm the crash-after-grace timer for open runs when no daemon is connected —
// shared by the disconnect handler (the daemon left) and a boot-time reattach
// where the daemon never connects (requestResume below). On expiry, if still no
// daemon, the open runs are crashed; a (re)connecting daemon clears it first and
// its resume-from governs instead. One timer for the single daemon.
function armGrace(): void {
  if (primary || !channels.size || graceTimer) return
  graceTimer = setTimeout(() => {
    graceTimer = null
    if (primary) return
    for (const channel of channels.values()) channel.push({ kind: 'crashed' })
  }, RECONNECT_GRACE_MS)
  graceTimer.unref()
}

// Ask the daemon to resume a run from the channel's last-applied seq. Used when a
// consumer reattaches to a run (a server reload or boot recovery); the symmetric
// case — a daemon connecting while the channel is already open — is handled in the
// connection handler. Both may fire; the daemon's replay is seq-deduped, so a
// double resume is harmless. With no daemon connected we instead arm the grace, so
// a run whose daemon never returns is eventually crashed rather than left hanging.
export function requestResume(runId: string): void {
  const channel = channels.get(runId)
  if (!channel) return
  const target = runOwner.get(runId) ?? primary
  if (!target) {
    armGrace()
    return
  }
  target.send(
    JSON.stringify({ type: 'resume-from', runId, seq: channel.lastSeq }),
  )
}

type DaemonServerOpts = {
  // Authenticates the daemon's upgrade: it must present this as `?token=`. Reuse
  // of the UI token (or a dedicated one) is the caller's choice.
  token: string
  // Called with the slugs the daemon serves on each `register` message.
  onRegister?: (slugs: string[]) => void
  // Called with each pushed usage snapshot, for the server to cache and serve.
  onUsage?: (body: UsageBody) => void
}

// Attach the daemon WS endpoint to the running HTTP server at /daemon. Handles
// auth, tracks the one connection, routes inbound messages, and on disconnect
// crashes every still-open run so its reducer can finalize it.
export function attachDaemonServer(
  server: HttpServer,
  opts: DaemonServerOpts,
): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname !== '/daemon') return // not ours — leave it for others
    if (url.searchParams.get('token') !== opts.token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
  })

  wss.on('connection', (ws: WebSocket) => {
    // The newcomer becomes primary — new runs go to it. Any daemon already
    // connected is a draining predecessor: it stays connected to finish the runs
    // it owns but takes no new ones. registeredSlugs tracks the primary, so clear
    // it for the newcomer's `register` to repopulate.
    daemons.add(ws)
    primary = ws
    registeredSlugs.clear()
    // A daemon is here — cancel any pending crash of open runs.
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
    console.log('daemon connected')
    // Resume the runs this primary should own: every open run not still held by a
    // live (draining) daemon. Adopt it and ask for a replay from our last-applied
    // seq — the daemon replays its buffer or aborts a run it no longer holds (e.g.
    // it restarted). Covers a link blip, a server reload (daemon outlived us), and
    // boot recovery. A run a draining predecessor still owns is left to finish
    // there; resuming it here would only draw a spurious abort.
    for (const [runId, channel] of channels) {
      const owner = runOwner.get(runId)
      if (owner && owner !== ws && daemons.has(owner)) continue
      runOwner.set(runId, ws)
      ws.send(JSON.stringify({ type: 'resume-from', runId, seq: channel.lastSeq }))
    }

    ws.on('message', (data) => {
      let msg: DaemonToServer
      try {
        msg = JSON.parse(data.toString()) as DaemonToServer
      } catch {
        return // ignore malformed frames
      }
      switch (msg.type) {
        case 'register':
          registeredSlugs.clear()
          for (const p of msg.projects) registeredSlugs.add(p.slug)
          opts.onRegister?.([...registeredSlugs])
          console.log(`daemon registered projects: ${[...registeredSlugs].join(', ') || '(none)'}`)
          break
        case 'update':
        case 'done':
        case 'session':
          channels.get(msg.runId)?.push({ kind: msg.type, msg } as RunEvent)
          break
        case 'usage':
          opts.onUsage?.({ session: msg.session, weekly: msg.weekly })
          break
      }
    })

    const drop = () => {
      if (!daemons.has(ws)) return // already gone
      daemons.delete(ws)
      if (primary === ws) {
        primary = null
        registeredSlugs.clear()
      }
      console.log('daemon disconnected')
      // Orphan the runs this daemon held — release them so whoever is/becomes
      // primary takes them over.
      const orphaned: string[] = []
      for (const [runId, owner] of runOwner)
        if (owner === ws) {
          runOwner.delete(runId)
          if (channels.has(runId)) orphaned.push(runId)
        }
      if (primary) {
        // Another daemon is still live (a draining predecessor died, or this was
        // one and the primary is fine): ask it to resume each orphan — it replays
        // if it holds it, else aborts it (a daemon that dropped mid-turn loses its
        // runs, same as a hard restart).
        for (const runId of orphaned) requestResume(runId)
      } else {
        // No daemon at all: don't crash open runs immediately — a reconnecting
        // daemon resumes them (resume-from on connect). Only if none returns
        // within the grace do we synthesize a crash so each reducer finalizes its
        // task (the file path's dead-runner branch).
        armGrace()
      }
    }
    ws.on('close', drop)
    ws.on('error', drop)
  })
}
