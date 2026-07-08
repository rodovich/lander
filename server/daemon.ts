// Server side of the daemon ⇄ server WebSocket link. This module owns the
// transport only: it accepts daemon connections, routes inbound run messages to
// the per-run channel a reducer is draining, and lets the server push run control
// back. The agent-specific reduction lives daemon-side; the task-mutation
// consumer lives in index.ts (applyUpdate/applyDone). So this file stays
// import-light — protocol types plus `ws` — and carries no task knowledge.

import type { IncomingMessage, Server as HttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type {
  DaemonToServer,
  ServerToDaemon,
  UpdateMessage,
  DoneMessage,
  SessionMessage,
  TurnContextMessage,
  UsageBody,
  AgentKind,
} from './protocol'

// One run's inbound events, delivered in order to the reducer awaiting them. The
// WS message handler pushes; reduceRunWs pulls via `next()`. A `crashed` event is
// synthesized when the daemon disconnects with this run still open, so the
// reducer finalizes the run the same way the file path treats a dead runner.
export type RunEvent =
  | { kind: 'update'; msg: UpdateMessage }
  | { kind: 'done'; msg: DoneMessage }
  | { kind: 'session'; msg: SessionMessage }
  | { kind: 'turn-context'; msg: TurnContextMessage }
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

// How long to hold an in-flight run open after its daemon drops before giving up
// and crashing it. Covers a brief link blip, a `tsx watch` server reload, and a
// daemon drain-handoff — in each case the holding daemon (re)connects and
// re-announces the run well inside this window; past it we assume it's gone.
const RECONNECT_GRACE_MS = 15_000

// Daemon connections. Normally one, but a drain-handoff briefly runs two: a daemon
// told to drain finishes its riding turns and exits (see the dev supervisor and
// the daemon's SIGUSR1 handler) while a fresh daemon connects and becomes
// `primary` — the one new runs go to. `runOwner` maps each in-flight run to the
// daemon holding it, rebuilt from what each daemon announces on `register`, so
// interrupt/resume-from/ack reach the right one and a run is only ever resumed on
// the daemon that actually holds it (never aborted by a daemon that doesn't).
let primary: WebSocket | null = null
const daemons = new Set<WebSocket>()
const runOwner = new Map<string, WebSocket>()
const registeredSlugs = new Set<string>()
const channels = new Map<string, RunChannel>()
const grantRequests = new Map<
  string,
  {
    resolve: (result: ProjectGrantResponse) => void
    timer: ReturnType<typeof setTimeout>
  }
>()
// Armed while some open run has no live owning daemon (its daemon dropped, or we
// just reloaded and it hasn't re-announced yet); on expiry those still-unowned
// runs are crashed. Reconciled — armed and cleared — by reconcileGrace.
let graceTimer: ReturnType<typeof setTimeout> | null = null

export function daemonConnected(): boolean {
  return primary != null
}

export function daemonServes(slug: string): boolean {
  return registeredSlugs.has(slug)
}

// The slugs the connected primary daemon currently serves. Empty when no daemon
// is connected (or a connected one registered none). Used to explain a wedge:
// "daemon connected but not serving <slug> — it serves [...]" vs "no daemon at all".
export function daemonSlugs(): string[] {
  return [...registeredSlugs]
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
  runOwner.delete(runId)
}

// Push a control message to the daemon that owns its run. `start-run` goes to the
// current primary and records it as the run's owner; interrupt/resume-from/ack
// follow that ownership, falling back to the primary for a run we have no owner
// for (harmless: a daemon that lacks the run no-ops an interrupt/ack). Returns
// false if there's no daemon to take it, so the caller can fall back.
export function sendToDaemon(msg: ServerToDaemon): boolean {
  let target: WebSocket | null
  if (msg.type === 'start-run') {
    target = primary
    if (target) runOwner.set(msg.runId, target)
  } else if (msg.type === 'project-grant') {
    target = primary
  } else {
    target = runOwner.get(msg.runId) ?? primary
  }
  if (!target) return false
  target.send(JSON.stringify(msg))
  return true
}

export type ProjectGrantResponse = {
  ok: boolean
  error?: string
  status?: number
}

export function requestProjectGrant(input: {
  project: string
  agent: AgentKind
  rule: string
  timeoutMs?: number
}): Promise<ProjectGrantResponse> {
  const requestId = randomUUID()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      grantRequests.delete(requestId)
      resolve({
        ok: false,
        error: 'daemon did not answer project grant request',
        status: 504,
      })
    }, input.timeoutMs ?? 15_000)
    timer.unref?.()
    grantRequests.set(requestId, { resolve, timer })
    const sent = sendToDaemon({
      type: 'project-grant',
      requestId,
      project: input.project,
      agent: input.agent,
      rule: input.rule,
    })
    if (!sent) {
      clearTimeout(timer)
      grantRequests.delete(requestId)
      resolve({
        ok: false,
        error: 'no daemon connected for this project',
        status: 503,
      })
    }
  })
}

// Open run-ids that no currently-connected daemon owns — candidates to crash once
// the reconnect grace lapses (their daemon never came back to claim them).
function unownedOpenRuns(): string[] {
  const out: string[] = []
  for (const runId of channels.keys()) {
    const owner = runOwner.get(runId)
    if (!owner || !daemons.has(owner)) out.push(runId)
  }
  return out
}

// Keep the crash-grace timer in step with reality: arm it whenever some open run
// has no live owning daemon (its daemon dropped, or we just reloaded and it hasn't
// re-announced yet), and clear it once every open run is claimed. On expiry, crash
// whatever is still unowned so its reducer finalizes the task (the file path's
// dead-runner branch). A (re)connecting daemon that announces its runs cancels it.
function reconcileGrace(): void {
  if (!unownedOpenRuns().length) {
    if (graceTimer) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
    return
  }
  if (graceTimer) return
  graceTimer = setTimeout(() => {
    graceTimer = null
    for (const runId of unownedOpenRuns())
      channels.get(runId)?.push({ kind: 'crashed' })
  }, RECONNECT_GRACE_MS)
  graceTimer.unref()
}

// Ask the daemon holding a run to replay it from the channel's last-applied seq.
// Used when a consumer reattaches to a run (a server reload or boot recovery). We
// only ask the owner — a daemon that doesn't hold the run would abort it, which
// with two daemons (a drain-handoff) would kill a run another daemon is finishing.
// When no live daemon owns it yet, we don't guess: arm the grace so the holder can
// (re)connect and announce it (then the register handler replays it), and crash it
// only if none does in time.
export function requestResume(runId: string): void {
  const channel = channels.get(runId)
  if (!channel) return
  const owner = runOwner.get(runId)
  if (owner && daemons.has(owner)) {
    owner.send(
      JSON.stringify({ type: 'resume-from', runId, seq: channel.lastSeq }),
    )
    return
  }
  reconcileGrace()
}

type DaemonServerOpts = {
  // Authenticates the daemon's upgrade: it must present this as `?token=`. Reuse
  // of the UI token (or a dedicated one) is the caller's choice.
  token: string
  // Called with the slugs the daemon serves on each primary `register` message.
  onRegister?: (slugs: string[]) => void
  // Called with each pushed usage snapshot, for the server to cache and serve.
  onUsage?: (body: UsageBody) => void
}

// Attach the daemon WS endpoint to the running HTTP server at /daemon. Handles
// auth, tracks connections, routes inbound messages, and crashes a run only once
// no connected daemon claims it past the reconnect grace.
export function attachDaemonServer(
  server: HttpServer,
  opts: DaemonServerOpts,
): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '', 'http://localhost')
    if (url.pathname !== '/daemon') return // not ours — leave it for others
    if (url.searchParams.get('token') !== opts.token) {
      // A token mismatch otherwise fails silently — the daemon just retries the
      // upgrade every second forever and no task can start. Log it so a desynced
      // LANDER_DAEMON_TOKEN (e.g. a manually restarted server, a stale data/
      // .ui-token) is visible rather than an invisible reconnect loop.
      console.warn(
        'daemon upgrade rejected (401): token mismatch — the daemon and server ' +
          'disagree on LANDER_DAEMON_TOKEN; the daemon will retry in a loop until ' +
          'they match.',
      )
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws))
  })

  wss.on('connection', (ws: WebSocket) => {
    daemons.add(ws)
    console.log('daemon connected')
    // Primary selection, ownership, and resume-from all wait for `register`: only
    // then do we know whether this daemon is draining (so not eligible for new
    // runs) and which in-flight runs it currently holds.

    ws.on('message', (data) => {
      let msg: DaemonToServer
      try {
        msg = JSON.parse(data.toString()) as DaemonToServer
      } catch {
        return // ignore malformed frames
      }
      switch (msg.type) {
        case 'register': {
          // A non-draining daemon is the live primary — new runs route to it. A
          // draining one (handing off) keeps only the runs it owns and takes none,
          // so it must not become primary.
          if (!msg.draining) {
            primary = ws
            registeredSlugs.clear()
            for (const p of msg.projects) registeredSlugs.add(p.slug)
            opts.onRegister?.([...registeredSlugs])
          }
          // Rebuild ownership from the runs the daemon says it holds, and replay
          // each open one from our last-applied seq. A daemon that omits `runs` is
          // a pre-announcement daemon — treat it the legacy single-daemon way:
          // assume it holds every open run (an empty array, by contrast, means it
          // genuinely holds none).
          const held = msg.runs ?? [...channels.keys()]
          for (const runId of held) {
            runOwner.set(runId, ws)
            const channel = channels.get(runId)
            if (channel)
              ws.send(
                JSON.stringify({ type: 'resume-from', runId, seq: channel.lastSeq }),
              )
          }
          reconcileGrace()
          console.log(
            `daemon registered (${msg.draining ? 'draining' : 'primary'}): ` +
              `${[...registeredSlugs].join(', ') || '(no slugs)'}; holds ${held.length} run(s)`,
          )
          break
        }
        case 'update':
        case 'done':
        case 'session':
        case 'turn-context':
          channels.get(msg.runId)?.push({ kind: msg.type, msg } as RunEvent)
          break
        case 'project-grant-result': {
          const pending = grantRequests.get(msg.requestId)
          if (!pending) break
          clearTimeout(pending.timer)
          grantRequests.delete(msg.requestId)
          pending.resolve({
            ok: msg.ok,
            error: msg.error,
            status: msg.status,
          })
          break
        }
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
      // Release the runs this daemon held. We don't reassign them to another
      // daemon — only the daemon that actually holds a run can replay it, so the
      // holder reclaims it by re-announcing on reconnect. If none does within the
      // grace, reconcileGrace crashes whatever stays unowned.
      for (const [runId, owner] of runOwner) if (owner === ws) runOwner.delete(runId)
      reconcileGrace()
    }
    ws.on('close', drop)
    ws.on('error', drop)
  })
}
