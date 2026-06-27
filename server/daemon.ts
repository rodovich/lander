// Server side of the daemon ⇄ server WebSocket link (see
// docs/daemon-server-split-plan.md). This module owns the transport only: it
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
  UsageBody,
} from './protocol'

// One run's inbound events, delivered in order to the reducer awaiting them. The
// WS message handler pushes; reduceRunWs pulls via `next()`. A `crashed` event is
// synthesized when the daemon disconnects with this run still open, so the
// reducer finalizes the run the same way the file path treats a dead runner.
export type RunEvent =
  | { kind: 'update'; msg: UpdateMessage }
  | { kind: 'done'; msg: DoneMessage }
  | { kind: 'crashed' }

// A single-consumer async queue: events buffer until pulled, and a pull before
// any event is pending parks until one arrives. One per in-flight WS run.
class RunChannel {
  private queue: RunEvent[] = []
  private waiter: ((e: RunEvent) => void) | null = null
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

// The single connected daemon (phase 1 is one daemon, same host). A later
// multi-daemon phase keys these by which daemon registered each slug.
let daemon: WebSocket | null = null
const registeredSlugs = new Set<string>()
const channels = new Map<string, RunChannel>()

export function daemonConnected(): boolean {
  return daemon != null
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

// Push a control message to the daemon (start-run / interrupt / resume-from).
// Returns false if no daemon is connected, so the caller can fall back.
export function sendToDaemon(msg: ServerToDaemon): boolean {
  if (!daemon) return false
  daemon.send(JSON.stringify(msg))
  return true
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
    // One daemon at a time: a new connection supersedes any stale one.
    daemon = ws
    registeredSlugs.clear()
    console.log('daemon connected')

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
          channels.get(msg.runId)?.push({ kind: msg.type, msg } as RunEvent)
          break
        case 'usage':
          opts.onUsage?.({ session: msg.session, weekly: msg.weekly })
          break
      }
    })

    const drop = () => {
      if (daemon !== ws) return // already superseded
      daemon = null
      registeredSlugs.clear()
      console.log('daemon disconnected')
      // Finalize every run this daemon was driving: synthesize a crash so each
      // reducer cleans up its task (the file path's dead-runner branch). A later
      // step adds a reconnect grace + resume-from before giving up.
      for (const channel of channels.values()) channel.push({ kind: 'crashed' })
    }
    ws.on('close', drop)
    ws.on('error', drop)
  })
}
