// The host daemon: owns the claude children the server used to spawn as detached
// `bin/lander run` runners, reduces their stream-json, and relays structured
// updates to the server over a WebSocket (see docs/daemon-server-split-plan.md).
// It holds the project host paths (its own argv), resolves each run's cwd
// locally, and runs claude natively — so the server can stay claude-agnostic and
// (later) move into a container. Phase 1: same host, same user, same credentials.
//
// Usage: node daemon/index.ts /path/to/project [/path/to/another ...]
//   env: LANDER_WS (server ws url, default ws://localhost:6181/daemon)
//        LANDER_DAEMON_TOKEN (must match the server's)
//        LANDER_IDLE_TIMEOUT_MS (per-run idle kill, default 10m — start-run wins)

import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'
import { reduceStreamLine, addUsage, type Usage } from '../server/stream'
import { projectSlug } from '../server/projects'
import type {
  ServerToDaemon,
  StartRunMessage,
  UpdateMessage,
  DoneMessage,
  RegisterMessage,
} from '../server/protocol'

const projectDirs = process.argv.slice(2).map((p) => path.resolve(p))
if (!projectDirs.length) {
  console.error('usage: node daemon/index.ts /path/to/project [more ...]')
  process.exit(1)
}
// Map each served slug to its host path; the server keys runs by slug and the
// daemon resolves the actual directory (decision 8).
const pathBySlug = new Map<string, string>()
for (const p of projectDirs) pathBySlug.set(projectSlug(p), p)

const WS_URL = process.env.LANDER_WS?.trim() || 'ws://localhost:6181/daemon'
const TOKEN = process.env.LANDER_DAEMON_TOKEN?.trim() || ''
const DEFAULT_IDLE_MS = Number(process.env.LANDER_IDLE_TIMEOUT_MS ?? 10 * 60_000)

// One in-flight run's handle, so an interrupt can stop it.
type Run = { interrupt: () => void }
const runs = new Map<string, Run>()

let ws: WebSocket | null = null

function send(msg: UpdateMessage | DoneMessage | RegisterMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

// Resolve a start-run's launch directory from the project slug + cwd hints — the
// stat/fallback/worktree logic relocated from the server's runTurn (decision 8).
// In a tracked worktree we launch from the project root and let claude's
// `--worktree` (already in claudeArgs) re-enter it; otherwise resume in the
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

// Spawn claude for one run, reduce its stream-json, and relay update/done. The
// reduction mirrors the old reduceRun accumulation (cross-line usage sum with
// per-inference dedup, sticky driving model / rate-limit reset), but here it runs
// next to the child and pushes each batch instead of a file tail pulling it.
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

  const child: ChildProcess = spawn('claude', msg.claudeArgs, {
    cwd,
    env: { ...process.env, ...msg.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // Run-scoped reduction state (carried across stdout chunks).
  let seq = 0
  let liveUsage: Usage | undefined
  let usageInf: string | undefined
  let drivingModel: string | undefined
  let rateLimitResetsAt: string | undefined
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
      const r = reduceStreamLine(line, new Date().toISOString())
      if (r.drivingModel) drivingModel = r.drivingModel
      if (r.rateLimitResetsAt) rateLimitResetsAt = r.rateLimitResetsAt
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
      send({
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
      })
    }
  }

  const finish = (exitCode: number): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    flush(true) // fold the final partial line
    send({
      type: 'done',
      runId: msg.runId,
      exitCode,
      interrupted,
      stderr: stderr.trim(),
    })
    runs.delete(msg.runId)
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
    stderr += `error running claude: ${e.message}`
    finish(1)
  })
  child.on('close', (code) => finish(code == null ? 1 : code))

  runs.set(msg.runId, {
    // Interrupt mirrors the old runner's SIGTERM handler: stop claude, finish
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
      startRun(msg)
      break
    case 'interrupt':
      runs.get(msg.runId)?.interrupt()
      break
    case 'resume-from':
      // Replay is a later step (the daemon holds no buffer yet); ignore for now.
      break
  }
}

// Dial the server, announce our projects, and reconnect with a fixed backoff if
// the link drops. In-flight children keep running across a brief reconnect, but
// their updates are lost until the resume-from step lands a replay buffer.
function connect(): void {
  const url = TOKEN ? `${WS_URL}?token=${encodeURIComponent(TOKEN)}` : WS_URL
  const sock = new WebSocket(url)
  ws = sock
  sock.addEventListener('open', () => {
    console.log(`connected to ${WS_URL}`)
    send({
      type: 'register',
      projects: [...pathBySlug.keys()].map((slug) => ({ slug })),
    })
  })
  sock.addEventListener('message', (ev) => onMessage(String(ev.data)))
  sock.addEventListener('close', () => {
    if (ws === sock) ws = null
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
