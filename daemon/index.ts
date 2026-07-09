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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentAdapter } from './agent'
import { createClaudeAdapter } from './claude'
import { codexOptionsFromEnv, createCodexAdapter } from './codex'
import { projectSlug } from '../server/projects'
import { fetchUsage, type UsageBody } from '../server/usage'
import type {
  ServerToDaemon,
  StartRunMessage,
  RegisterMessage,
  UsageMessage,
  ProjectGrantResultMessage,
  AgentKind,
} from '../server/protocol'
import { createRunManager, type RunManagerMessage } from './run'
import { resolveRunCwd } from './paths'
import {
  materializeAttachments,
  taskFilesDir,
  defaultFilesRoot,
  type MaterializedFiles,
} from './attachments'
import type { AttachmentRef } from '../server/protocol'

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
const TASK_PROMPT_TEMPLATE = readFileSync(
  path.join(ROOT, 'server', 'task-prompt.md'),
  'utf8',
).trim()
const CLAUDE_ADAPTER = createClaudeAdapter({
  landerBin: path.join(ROOT, 'bin', 'lander'),
  taskPromptTemplate: TASK_PROMPT_TEMPLATE,
})
const CODEX_ADAPTER = createCodexAdapter({
  taskPromptTemplate: TASK_PROMPT_TEMPLATE,
  ...codexOptionsFromEnv(process.env),
})
const ADAPTERS = {
  claude: CLAUDE_ADAPTER,
  codex: CODEX_ADAPTER,
} satisfies Record<AgentKind, AgentAdapter>

let ws: WebSocket | null = null
// Set by SIGUSR1 (the dev supervisor's drain signal): finish the runs we're
// riding, take no new ones, and exit once they're all done — handing off to the
// fresh daemon the supervisor spawned. A daemon source edit thus never interrupts
// an in-flight turn. SIGTERM still hard-kills as the supervisor's max-drain cap.
let draining = false

function send(
  msg:
    | RunManagerMessage
    | RegisterMessage
    | UsageMessage
    | ProjectGrantResultMessage,
): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

// Once draining, exit cleanly the moment our last run is acked/dropped, so the
// fresh daemon is the only one left. No-op until then — we keep relaying our
// in-flight runs and honoring interrupts for them.
function exitIfDrained(): void {
  if (draining && runManager.size() === 0) {
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

// Resolve a start-run's launch directories from the project slug + cwd hints.
// The cwd rule (worktree flag vs recorded cwd) lives in resolveRunCwd.
function resolveRunPaths(
  msg: StartRunMessage,
  adapter: AgentAdapter,
): { root: string; cwd: string } {
  const root = pathBySlug.get(msg.project)
  if (!root) throw new Error(`daemon serves no project for slug ${msg.project}`)
  return { root, cwd: resolveRunCwd(msg, adapter, root) }
}

// Root under which each task's materialized attachment blobs live (cached across
// turns). Overridable for tests/containers; defaults to the OS temp dir.
// (Claude reads attached images from here via the adapter's --add-dir grant.)
const FILES_ROOT = process.env.LANDER_FILES_ROOT?.trim() || defaultFilesRoot()

// Fetch an attachment's bytes from the server's authed download endpoint,
// authenticating as the task (the same LANDER_TOKEN/headers the in-task CLI
// sends). The run's env carries the API base and identity.
async function fetchAttachmentBytes(
  env: Record<string, string>,
  ref: AttachmentRef,
): Promise<Uint8Array> {
  const api = env.LANDER_API
  const project = env.LANDER_PROJECT
  if (!api || !project)
    throw new Error('run env lacks LANDER_API/LANDER_PROJECT for attachment fetch')
  const headers: Record<string, string> = {}
  if (env.LANDER_TASK) headers['x-lander-task'] = env.LANDER_TASK
  headers['x-lander-project'] = project
  if (env.LANDER_TOKEN) headers['x-lander-token'] = env.LANDER_TOKEN
  const res = await fetch(
    `${api}/api/${project}/attachments/${encodeURIComponent(ref.id)}`,
    { headers },
  )
  if (!res.ok)
    throw new Error(`attachment ${ref.id}: ${res.status} ${res.statusText}`)
  return new Uint8Array(await res.arrayBuffer())
}

// Materialize a run's attachments into its per-task files dir and build the
// prompt manifest. Bound to the start message's project/task and env identity.
async function materialize(
  msg: StartRunMessage,
  { visionNative }: { visionNative: boolean },
): Promise<MaterializedFiles | undefined> {
  if (!msg.attachments?.length) return undefined
  const filesDir = taskFilesDir(FILES_ROOT, msg.project, msg.taskId)
  return materializeAttachments({
    filesDir,
    attachments: msg.attachments,
    fetchBytes: (ref) => fetchAttachmentBytes(msg.env, ref),
    visionNative,
  })
}

const runManager = createRunManager({
  adapters: ADAPTERS,
  resolveRunPaths,
  send,
  // Point LANDER_FILES_DIR at the task's persistent store every turn, so a file
  // attached on an earlier turn stays reachable via `lander file cat/ls`.
  resolveFilesDir: (msg) => taskFilesDir(FILES_ROOT, msg.project, msg.taskId),
  materialize,
  refreshUsage,
  defaultIdleMs: DEFAULT_IDLE_MS,
  onEmpty: exitIfDrained,
})

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
      runManager.startRun(msg)
      break
    case 'project-grant': {
      const projectPath = pathBySlug.get(msg.project)
      const adapter = ADAPTERS[msg.agent]
      if (!projectPath) {
        send({
          type: 'project-grant-result',
          requestId: msg.requestId,
          ok: false,
          error: `daemon serves no project for slug ${msg.project}`,
          status: 404,
        })
        break
      }
      if (!adapter.supportsProjectGrants || !adapter.persistProjectGrant) {
        send({
          type: 'project-grant-result',
          requestId: msg.requestId,
          ok: false,
          error:
            msg.agent === 'codex'
              ? 'Project permission grants are not supported for Codex tasks yet.'
              : `Project permission grants are not supported for ${msg.agent} tasks.`,
          status: 400,
        })
        break
      }
      adapter
        .persistProjectGrant({ projectPath, rule: msg.rule })
        .then(() =>
          send({
            type: 'project-grant-result',
            requestId: msg.requestId,
            ok: true,
          }),
        )
        .catch((e) =>
          send({
            type: 'project-grant-result',
            requestId: msg.requestId,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            status: 500,
          }),
        )
      break
    }
    case 'interrupt':
      runManager.interrupt(msg.runId)
      break
    case 'resume-from':
      runManager.resumeFrom(msg.runId, msg.seq)
      break
    case 'ack':
      runManager.ack(msg.runId)
      break
  }
}

// Kill any live agent children — best effort, on our own termination — so a
// daemon restart doesn't orphan them (decision 2 aborts in-flight turns anyway).
function killChildren(): void {
  runManager.killChildren()
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
  console.log(`draining ${runManager.size()} run(s) before handoff`)
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
      runs: runManager.heldRunIds(),
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
