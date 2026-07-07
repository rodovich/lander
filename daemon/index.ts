// The host daemon: owns the agent children the server used to spawn as detached
// `bin/lander run` runners, reduces their stream-json, and relays structured
// updates to the server over a WebSocket.
// It holds the project host paths (its own argv), resolves each run's cwd
// locally, and runs the agent CLI natively — so the server can stay host-agnostic and
// (later) move into a container. Phase 1: same host, same user, same credentials.
//
// Usage: node daemon/index.ts /path/to/project [/path/to/another ...]
//   env: LANDER_WS (server ws url, default ws://localhost:6181/daemon)
//        LANDER_DAEMON_TOKEN (must match the server's)
//        LANDER_IDLE_TIMEOUT_MS (per-run idle kill, default 10m — start-run wins)

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClaudeAdapter } from '../server/claude'
import { createCodexAdapter } from '../server/codex'
import type { AgentAdapter } from '../server/agent'
import { addUsage, type Usage } from '../server/stream'
import { projectSlug } from '../server/projects'
import { fetchUsage, type UsageBody } from '../server/usage'
import type {
  ServerToDaemon,
  StartRunMessage,
  UpdateMessage,
  DoneMessage,
  SessionMessage,
  RegisterMessage,
  UsageMessage,
} from '../server/protocol'

// Project host paths come from argv, or PROJECT_DIRS (newline-separated, as
// dev.mjs sets for the server) when argv is empty — so `npm run dev` can launch
// the daemon with the same env the server gets.
const fromArgv = process.argv.slice(2)
const fromEnv = (process.env.PROJECT_DIRS ?? '')
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
const projectDirs = (fromArgv.length ? fromArgv : fromEnv).map((p) =>
  path.resolve(p),
)
if (!projectDirs.length) {
  console.error(
    'usage: node daemon/index.ts /path/to/project [more ...]  (or set PROJECT_DIRS)',
  )
  process.exit(1)
}
// Map each served slug to its host path; the server keys runs by slug and the
// daemon resolves the actual directory (decision 8).
const pathBySlug = new Map<string, string>()
for (const p of projectDirs) pathBySlug.set(projectSlug(p), p)

const WS_URL = process.env.LANDER_WS?.trim() || 'ws://localhost:6181/daemon'
const TOKEN = process.env.LANDER_DAEMON_TOKEN?.trim() || ''
const DEFAULT_IDLE_MS = Number(process.env.LANDER_IDLE_TIMEOUT_MS ?? 10 * 60_000)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLAUDE_ADAPTER = createClaudeAdapter({
  landerBin: path.join(ROOT, 'bin', 'lander'),
  taskPromptTemplate: readFileSync(
    path.join(ROOT, 'server', 'task-prompt.md'),
    'utf8',
  ).trim(),
})
const CODEX_ADAPTER = createCodexAdapter()

function agentAdapter(kind: StartRunMessage['agent']): AgentAdapter | undefined {
  if (kind === 'claude') return CLAUDE_ADAPTER
  if (kind === 'codex') return CODEX_ADAPTER
  return undefined
}

// One run's handle. Held from start until the server acks its `done` (or a
// bounded timeout), so a reconnecting server can resume-from the buffer. `buffer`
// is every update sent for the run, in seq order; `done` is set once finished.
type Run = {
  interrupt: () => void
  child: ChildProcess
  buffer: UpdateMessage[]
  // The session id this run announced (only when it began a fresh session, i.e.
  // the server sent no `sessionId` to resume). Re-sent ahead of the buffer on
  // resume-from so a server that reconnected mid-first-turn still learns it.
  mintedSession?: string
  done?: DoneMessage
  dropTimer?: ReturnType<typeof setTimeout>
}
const runs = new Map<string, Run>()
// How long to retain a finished run's buffer waiting for the server's ack before
// dropping it, so a lost ack can't leak the buffer forever.
const RUN_BUFFER_TTL_MS = 120_000

let ws: WebSocket | null = null
// Set by SIGUSR1 (the dev supervisor's drain signal): finish the runs we're
// riding, take no new ones, and exit once they're all done — handing off to the
// fresh daemon the supervisor spawned. A daemon source edit thus never interrupts
// an in-flight turn. SIGTERM still hard-kills as the supervisor's max-drain cap.
let draining = false

function send(
  msg:
    | UpdateMessage
    | DoneMessage
    | SessionMessage
    | RegisterMessage
    | UsageMessage,
): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

// Once draining, exit cleanly the moment our last run is acked/dropped, so the
// fresh daemon is the only one left. No-op until then — we keep relaying our
// in-flight runs and honoring interrupts for them.
function exitIfDrained(): void {
  if (draining && runs.size === 0) {
    console.log('drained; exiting for handoff')
    process.exit(0)
  }
}

// ── Usage (decision 6) ──────────────────────────────────────────────────────
// The daemon owns the account usage snapshot end to end: it reads the credential,
// hits the OAuth endpoint, runs the whole refresh schedule (60s floor, per-turn
// trigger, reset timer, boot/connect fetch), and pushes each snapshot to the
// server — which only caches and serves it. This is the logic that used to live
// in the server; only the credential read + fetch are shared (server/usage.ts).
const USAGE_TTL_MS = 60_000
let usageBody: UsageBody | null = null
let usageAt = 0
let usageRefreshing = false
let usageResetTimer: ReturnType<typeof setTimeout> | null = null

function pushUsage(): void {
  if (usageBody)
    send({ type: 'usage', session: usageBody.session, weekly: usageBody.weekly })
}

// Fetch unless a snapshot was taken within the TTL — the single 60s floor every
// trigger shares (per-turn, reset timer, boot/connect), so none can hammer the
// endpoint or the keychain. A fresh fetch pushes to the server and re-arms the
// reset timer; a failed one leaves the last snapshot in place.
function refreshUsage(): Promise<void> {
  if (usageBody && Date.now() - usageAt < USAGE_TTL_MS) return Promise.resolve()
  if (usageRefreshing) return Promise.resolve()
  usageRefreshing = true
  return (async () => {
    const r = await fetchUsage()
    if (r.ok) {
      usageBody = r.body
      usageAt = Date.now()
      pushUsage()
      scheduleUsageReset(r.body)
    }
  })().finally(() => {
    usageRefreshing = false
  })
}

// Arm a one-shot refresh just after the soonest window resets, so the readout
// catches utilization dropping back without waiting for the next turn; re-arms
// itself from each fresh snapshot. A reset already past clamps to the TTL.
function scheduleUsageReset(body: UsageBody): void {
  const resets = [body.session?.resetsAt, body.weekly?.resetsAt]
    .map((s) => (s ? Date.parse(s) : NaN))
    .filter((n) => Number.isFinite(n))
  if (!resets.length) return
  const delay = Math.max(Math.min(...resets) + 2_000 - Date.now(), USAGE_TTL_MS)
  if (usageResetTimer) clearTimeout(usageResetTimer)
  usageResetTimer = setTimeout(() => {
    usageResetTimer = null
    void refreshUsage()
  }, delay)
  usageResetTimer.unref()
}

// Resolve a start-run's launch directory from the project slug + cwd hints — the
// stat/fallback/worktree logic relocated from the server's runTurn (decision 8).
// In a tracked worktree we launch from the project root and let Claude's
// `--worktree` (already in agentArgs) re-enter it; otherwise resume in the
// recorded dir if it still exists, falling back to the root.
function resolveCwd(msg: StartRunMessage): string {
  const root = pathBySlug.get(msg.project)
  if (!root) throw new Error(`daemon serves no project for slug ${msg.project}`)
  if (!msg.worktree && msg.recordedCwd && msg.recordedCwd !== root) {
    try {
      if (statSync(msg.recordedCwd).isDirectory()) return msg.recordedCwd
    } catch {
      // recorded dir is gone — fall back to the project root
    }
  }
  return root
}

// Spawn the selected agent for one run, reduce its stream, and relay update/done.
// The provider adapter owns the CLI command, session start/resume args, and line
// reducer. The daemon keeps process ownership, replay buffering, idle-kill, and
// cross-line usage accumulation provider-neutral.
function startRun(msg: StartRunMessage): void {
  let cwd: string
  try {
    cwd = resolveCwd(msg)
  } catch (e) {
    // No such project here — report a clean failure so the task doesn't hang.
    send({
      type: 'done',
      runId: msg.runId,
      exitCode: 1,
      interrupted: false,
      stderr: e instanceof Error ? e.message : String(e),
    })
    return
  }

  const adapter = agentAdapter(msg.agent)
  if (!adapter) {
    send({
      type: 'done',
      runId: msg.runId,
      exitCode: 1,
      interrupted: false,
      stderr: `unsupported agent: ${msg.agent}`,
    })
    return
  }

  const session = adapter.buildSession({
    sessionId: msg.sessionId,
    mintSessionId: randomUUID,
  })

  const child: ChildProcess = spawn(
    adapter.command,
    [...session.args, ...msg.agentArgs],
    {
      cwd,
      env: { ...process.env, ...msg.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  // Tell the server the session id for a fresh run, whether the adapter minted
  // it before spawn (Claude) or extracts it from the stream (Codex). A resume
  // already knows its session id.
  let announcedSession = session.announceSession ? session.sessionId : undefined
  if (announcedSession)
    send({ type: 'session', runId: msg.runId, sessionId: announcedSession })

  // Run-scoped reduction state (carried across stdout chunks).
  let seq = 0
  // Every update sent, in seq order — retained so a reconnecting server can be
  // replayed from its last-applied seq (resume-from).
  const buffer: UpdateMessage[] = []
  let liveUsage: Usage | undefined
  let usageInf: string | undefined
  let drivingModel: string | undefined
  let rateLimitResetsAt: string | undefined
  let terminalError: string | undefined
  let sawRateLimit = false
  let buf = ''
  let stderr = ''
  let settled = false
  let interrupted = false

  // Idle-kill: a run silent past the window is presumed stuck; any output re-arms.
  const idleMs = msg.idleTimeoutMs || DEFAULT_IDLE_MS
  let timer: ReturnType<typeof setTimeout>
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }, idleMs)
  }
  arm()

  // Reduce whatever complete lines are buffered and push one update for the batch.
  // `final` flushes the trailing partial line too (mirrors reduceRun stopping at
  // the last newline until done). One update per batch keeps the apply cadence
  // close to the file path's per-poll batching.
  const flush = (final: boolean): void => {
    if (!buf) return
    const nl = buf.lastIndexOf('\n')
    if (nl < 0 && !final) return
    const chunk = final ? buf : buf.slice(0, nl + 1)
    buf = final ? '' : buf.slice(nl + 1)

    const steps: UpdateMessage['steps'] = []
    let finalText: string | undefined
    const blockedIds: string[] = []
    let usageChanged = false
    for (const raw of chunk.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      if (!msg.sessionId && !announcedSession) {
        const sessionId = adapter.extractSession?.(line)
        if (sessionId) {
          announcedSession = sessionId
          const rec = runs.get(msg.runId)
          if (rec) rec.mintedSession = sessionId
          send({ type: 'session', runId: msg.runId, sessionId })
        }
      }
      const r = adapter.reduceLine(line, new Date().toISOString())
      if (r.drivingModel) drivingModel = r.drivingModel
      if (r.rateLimitResetsAt && !sawRateLimit) {
        // First session-limit rejection this run — the window just filled, a
        // usage-moving event, so refresh now (shares the 60s floor).
        sawRateLimit = true
        if (adapter.supportsUsageSnapshot) void refreshUsage()
      }
      if (r.rateLimitResetsAt) rateLimitResetsAt = r.rateLimitResetsAt
      if (r.terminalError) {
        if (!terminalError) terminalError = r.terminalError
        else if (!terminalError.includes(r.terminalError))
          terminalError += `\n${r.terminalError}`
      }
      steps.push(...r.steps)
      if (r.finalText !== undefined) finalText = r.finalText
      if (r.blockedIds) blockedIds.push(...r.blockedIds)
      if (r.usage) {
        if (r.usageFinal) {
          // The result event's authoritative total supersedes the estimate.
          liveUsage = r.usage
          usageChanged = true
        } else if (r.usageInferenceId !== usageInf) {
          // A new inference's usage — add it once (its content-block events
          // repeat the same numbers under the same id).
          usageInf = r.usageInferenceId
          liveUsage = addUsage(liveUsage, r.usage)
          usageChanged = true
        }
      }
    }

    if (steps.length || finalText !== undefined || blockedIds.length || usageChanged) {
      const u: UpdateMessage = {
        type: 'update',
        runId: msg.runId,
        seq: ++seq,
        steps,
        finalText,
        blockedIds,
        usage: usageChanged ? liveUsage : undefined,
        usageChanged,
        drivingModel,
        rateLimitResetsAt,
      }
      buffer.push(u)
      send(u)
    }
  }

  const finish = (exitCode: number): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    flush(true)
    const doneStderr = [stderr.trim(), terminalError?.trim()]
      .filter(Boolean)
      .join('\n')
    const doneMsg: DoneMessage = {
      type: 'done',
      runId: msg.runId,
      exitCode: exitCode === 0 && terminalError && !interrupted ? 1 : exitCode,
      interrupted,
      stderr: doneStderr,
    }
    // Keep the run record (buffer + done) until the server acks, so a reconnect
    // can replay it; a timeout drops it if the ack is lost. Don't delete here.
    const rec = runs.get(msg.runId)
    if (rec) {
      rec.done = doneMsg
      rec.dropTimer = setTimeout(() => {
        runs.delete(msg.runId)
        exitIfDrained()
      }, RUN_BUFFER_TTL_MS)
      rec.dropTimer.unref()
    }
    send(doneMsg)
    // A turn just finished — agent activity is when usage moves, so refresh.
    if (adapter.supportsUsageSnapshot) void refreshUsage()
  }

  child.stdout!.on('data', (d: Buffer) => {
    arm()
    buf += d.toString()
    flush(false)
  })
  child.stderr!.on('data', (d: Buffer) => {
    arm()
    stderr += d.toString()
  })
  child.on('error', (e) => {
    stderr += `error running assistant: ${e.message}`
    finish(1)
  })
  child.on('close', (code) => finish(code == null ? 1 : code))

  runs.set(msg.runId, {
    child,
    buffer,
    mintedSession: announcedSession,
    // Interrupt mirrors the old runner's SIGTERM handler: stop the agent, finish
    // cleanly as interrupted (the server keeps the partial reply, no crash).
    interrupt: () => {
      interrupted = true
      try {
        child.kill('SIGKILL')
      } catch {}
      finish(0)
    },
  })
}

function onMessage(raw: string): void {
  let msg: ServerToDaemon
  try {
    msg = JSON.parse(raw) as ServerToDaemon
  } catch {
    return
  }
  switch (msg.type) {
    case 'start-run':
      if (draining) {
        // We're handing off; the server routes new runs to the fresh primary, so
        // this shouldn't arrive — but if it does, abort cleanly rather than start
        // work we'd interrupt at exit.
        send({
          type: 'done',
          runId: msg.runId,
          exitCode: 1,
          interrupted: false,
          stderr: 'daemon draining; run not started',
        })
        break
      }
      startRun(msg)
      break
    case 'interrupt':
      runs.get(msg.runId)?.interrupt()
      break
    case 'resume-from': {
      const r = runs.get(msg.runId)
      if (!r) {
        // We no longer hold this run — we restarted (decision 2: a daemon restart
        // aborts in-flight turns), or already dropped it after ack/timeout. Abort
        // it so the server finalizes instead of hanging.
        send({
          type: 'done',
          runId: msg.runId,
          exitCode: 1,
          interrupted: false,
          stderr: 'daemon has no record of this run (restarted?); run aborted',
        })
        break
      }
      // Re-announce a minted session id first: a server that reconnected mid
      // first-turn may not have persisted it yet, and it must land before the
      // run's done so the next turn can resume. Idempotent on the server side.
      if (r.mintedSession)
        send({ type: 'session', runId: msg.runId, sessionId: r.mintedSession })
      // Replay everything past the server's last-applied seq, then the terminal
      // done if the run already finished. The server seq-dedups, so replaying a
      // few it already has is harmless.
      for (const u of r.buffer) if (u.seq > msg.seq) send(u)
      if (r.done) send(r.done)
      break
    }
    case 'ack': {
      const r = runs.get(msg.runId)
      if (r?.dropTimer) clearTimeout(r.dropTimer)
      runs.delete(msg.runId)
      exitIfDrained()
      break
    }
  }
}

// Kill any live agent children — best effort, on our own termination — so a
// daemon restart doesn't orphan them (decision 2 aborts in-flight turns anyway).
function killChildren(): void {
  for (const r of runs.values()) {
    try {
      r.child.kill('SIGKILL')
    } catch {}
  }
}
process.on('SIGTERM', () => {
  killChildren()
  process.exit(0)
})
process.on('SIGINT', () => {
  killChildren()
  process.exit(0)
})

// Graceful handoff (drain): the dev supervisor (daemon-watch.mjs) sends SIGUSR1 on
// a daemon source edit instead of killing us. Stop taking new runs (the server
// already routes those to the fresh daemon), finish the turns we're riding, and
// exit once they're done — so a code edit never interrupts an in-flight turn.
process.on('SIGUSR1', () => {
  if (draining) return
  draining = true
  console.log(`draining ${runs.size} run(s) before handoff`)
  exitIfDrained()
})

// Dial the server, announce our projects, and reconnect with a fixed backoff if
// the link drops. In-flight children keep running across a reconnect, and their
// updates are retained per run, so the server resumes them (resume-from) from its
// last-applied seq once it's back.
function connect(): void {
  const url = TOKEN ? `${WS_URL}?token=${encodeURIComponent(TOKEN)}` : WS_URL
  const sock = new WebSocket(url)
  ws = sock
  sock.addEventListener('open', () => {
    console.log(`connected to ${WS_URL}`)
    send({
      type: 'register',
      projects: [...pathBySlug.keys()].map((slug) => ({ slug })),
      // Tell the server whether we're handing off (so it routes no new runs to us)
      // and exactly which in-flight runs we still hold, so it resumes each only on
      // its real owner — and a reconnect mid-drain reclaims our runs instead of
      // losing them to the fresh primary.
      draining,
      runs: [...runs.keys()],
    })
    // Prime the server's snapshot: re-push the last one we hold (so a reconnect
    // re-fills the server cache immediately), then fetch a fresh one (the boot /
    // connect trigger; the TTL floor collapses a redundant fetch).
    if (CLAUDE_ADAPTER.supportsUsageSnapshot) {
      pushUsage()
      void refreshUsage()
    }
  })
  sock.addEventListener('message', (ev) => onMessage(String(ev.data)))
  sock.addEventListener('close', () => {
    if (ws === sock) ws = null
    // Always reconnect — including while draining. A server reload drops us
    // mid-drain, and only we still hold our in-flight runs, so we must reconnect
    // and re-announce them (with draining:true) for the server to resume them on
    // us rather than crash them. draining:true keeps the server from routing new
    // runs to us, and we still exit once our runs finish.
    console.log('disconnected; retrying in 1s')
    setTimeout(connect, 1000)
  })
  sock.addEventListener('error', () => {
    try {
      sock.close()
    } catch {}
  })
}

console.log('daemon projects:')
for (const [slug, p] of pathBySlug) console.log(`  ${slug}  ${p}`)
connect()
