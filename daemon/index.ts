// The host daemon: owns the agent children the server used to spawn as detached
// `bin/lander run` runners, reduces their stream-json, and relays structured
// updates to the server over a WebSocket.
// It holds the project host paths (its own argv), resolves each run's cwd
// locally, and runs the agent CLI natively — so the server can stay host-agnostic and
// (later) move into a container. Phase 1: same host, same user, same credentials.
//
// Usage: node daemon/index.ts /path/to/project [/path/to/another ...]
//   env: LANDER_WS (server ws url, default ws://localhost:6181/daemon)
//        LANDER_DAEMON_TOKEN (must match the server's; read once at startup and
//          then deleted from the environment, so it is not inherited by the flow
//          hosts and agent children this process spawns — see server/secrets.ts)
//        LANDER_IDLE_TIMEOUT_MS (idle-kill fallback, default 15m — start-run wins)

import path from 'node:path'
import type { AgentAdapter } from './agent'
import { buildAdapters, ROOT } from './adapters'
import { projectSlug } from '../server/projects'
import {
  FLOW_MODULES,
  announcedFlows,
  providerCaps,
  type ProviderCaps,
} from './flows/index'
import { scrubProcessEnv } from '../server/secrets'
import type { AgentKind, TelemetryItem } from '../server/protocol'
import type {
  ServerToDaemon,
  StartRunMessage,
  HooksResolveMessage,
  HookRunMessage,
  RegisterMessage,
  TelemetryMessage,
  ProjectGrantResultMessage,
  HooksResolveResultMessage,
  HookRunResultMessage,
} from '../server/protocol'
import { gitExec, resolveHooks } from './hooks'
import { createHookRuns, runHook } from './hook-run'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRunManager, type RunManagerMessage } from './run'
import { createDrain } from './drain'
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
// Drop lander's own credentials from the environment now that TOKEN holds the
// one this process needs — it is a module const, reused by every reconnect, so
// nothing reads the variable again. Everything the daemon spawns inherits
// `{ ...process.env }` (the flow host, and through it the agent child), so
// without this the UI token reached every task's shell, where presenting it as
// `x-lander-ui-token` resolves as the trusted human on every route.
//
// Here rather than in daemon-watch.mjs: the watcher spawns each daemon with its
// own env and must keep the value to hand to the successor across a drain
// handoff. Here rather than at the spawn sites: a new spawn site can forget a
// filter, but it cannot un-inherit what is no longer in the environment.
scrubProcessEnv()
const DEFAULT_IDLE_MS = Number(process.env.LANDER_IDLE_TIMEOUT_MS ?? 15 * 60_000)
const ADAPTERS = buildAdapters({ root: ROOT, env: process.env })
// What the daemon needs to know about each provider before a host exists —
// answered by its flow once it has cut over, by its compiled adapter until then.
// The run manager is written against this single shape, so flipping a provider is
// a change of source here, not a change of shape there.
const CAPS = providerCaps(ADAPTERS)

let ws: WebSocket | null = null

function send(
  msg:
    | RunManagerMessage
    | RegisterMessage
    | TelemetryMessage
    | ProjectGrantResultMessage
    | HooksResolveResultMessage
    | HookRunResultMessage,
): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

// ── Usage ───────────────────────────────────────────────────────────────────
// The daemon owns the SCHEDULE for the global usage panel — the 60s TTL floor
// every trigger shares, the per-turn trigger, the boot/connect fetch, and the
// reset timer — because that schedule has to run when no run, and therefore no
// flow host, is alive. It no longer owns the CONTENT: what a snapshot is (the
// credential read, the fetch, the item mapping, and when to look again) belongs
// to whichever flow declares usageSnapshot, reached through its out-of-turn
// onStatus hook. A provider that publishes nothing simply exports no hook and its
// panel stays empty.
const USAGE_TTL_MS = 60_000
// The provider whose flow owns the panel. At most one does today; a registry
// makes this a list later.
const USAGE_AGENT = (Object.keys(CAPS) as AgentKind[]).find(
  (agent) => CAPS[agent].usageSnapshot,
)
let usageItems: TelemetryItem[] | null = null
let usageAt = 0
let usageRefreshing = false
let usageResetTimer: ReturnType<typeof setTimeout> | null = null

function pushUsage(): void {
  if (usageItems && USAGE_AGENT)
    send({
      type: 'telemetry',
      agent: USAGE_AGENT,
      // The flow name is the cache key going forward; `agent` rides along until
      // step 5 retires it, so an older server still keys this correctly.
      flow: USAGE_AGENT,
      items: usageItems,
    })
}

// Refresh unless a snapshot was taken within the TTL, so no trigger can hammer
// the endpoint or the keychain. A fresh snapshot pushes to the server and re-arms
// the reset timer; a failed one leaves the last snapshot in place.
function refreshUsage(): Promise<void> {
  if (!USAGE_AGENT) return Promise.resolve()
  if (usageItems && Date.now() - usageAt < USAGE_TTL_MS) return Promise.resolve()
  if (usageRefreshing) return Promise.resolve()
  const onStatus = FLOW_MODULES[USAGE_AGENT].onStatus
  if (!onStatus) return Promise.resolve()
  usageRefreshing = true
  return (async () => {
    const snapshot = await onStatus()
    if (snapshot) {
      usageItems = snapshot.items as TelemetryItem[]
      usageAt = Date.now()
      pushUsage()
      scheduleUsageReset(snapshot.refreshAt)
    }
  })()
    .catch(() => {
      // A flow hook that throws must not take the daemon's schedule down with
      // it; the last snapshot stands until the next trigger.
    })
    .finally(() => {
      usageRefreshing = false
    })
}

// Arm a one-shot refresh just after the flow says its windows reset, so the
// readout catches utilization dropping back without waiting for the next turn.
// Clamped to the TTL floor: a reset already in the past must not become a busy
// loop.
function scheduleUsageReset(refreshAt: string | undefined): void {
  if (!refreshAt) return
  const at = Date.parse(refreshAt)
  if (!Number.isFinite(at)) return
  const delay = Math.max(at - Date.now(), USAGE_TTL_MS)
  if (usageResetTimer) clearTimeout(usageResetTimer)
  usageResetTimer = setTimeout(() => {
    usageResetTimer = null
    void refreshUsage()
  }, delay)
  usageResetTimer.unref()
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// Resolve a start-run's launch directories from the project slug + cwd hints. The
// cwd rule (launch at root + re-enter a worktree, or resume from the recorded cwd)
// belongs to the provider — its flow once cut over, its adapter until then — and
// the daemon just launches where it says, threading the re-entry argv + landed
// dir on to the host. It runs here rather than in the host because it stats
// directories on the daemon's own filesystem to make the call.
function resolveRunPaths(
  msg: StartRunMessage,
  caps: ProviderCaps,
): { root: string; cwd: string; reentryArgs: string[]; effectiveCwd?: string } {
  const root = pathBySlug.get(msg.project)
  if (!root) throw new Error(`daemon serves no project for slug ${msg.project}`)
  const launch = caps.resolveLaunchDir({
    root,
    recordedCwd: msg.recordedCwd,
    worktree: msg.task.worktree,
    isDir,
  })
  return {
    root,
    cwd: launch.cwd,
    reentryArgs: launch.reentryArgs,
    ...(launch.effectiveCwd ? { effectiveCwd: launch.effectiveCwd } : {}),
  }
}

// Which checkout a hook resolution reads. The tree that matters is the one the
// target task is working in, so this goes through the same provider-owned
// resolveLaunchDir a run does — `effectiveCwd` being where the agent actually
// works when the flow re-enters a worktree through argv.
//
// It falls back to the project root twice over: for a flow the daemon does not
// know (a resolve can arrive for any task, including one whose flow this build
// has never heard of), and for a resolved directory that is no longer there (a
// removed worktree). Answering from the root is the honest degradation — that
// tree's hooks are the project's — where answering from a missing directory would
// report "not a git repository" for a repository that plainly is one.
//
// The root travels with it because resolution checks that the two are the same
// repository before reading the target's: both hints are task-writable, so a
// directory being under the project root does not make it the project's tree.
function resolveHooksCwd(
  project: string,
  hints: { flow?: string; recordedCwd?: string; worktree?: string },
): {
  root: string
  cwd: string
} {
  const root = pathBySlug.get(project)
  if (!root) throw new Error(`daemon serves no project for slug ${project}`)
  const caps = hints.flow ? CAPS[hints.flow] : undefined
  if (!caps) return { root, cwd: root }
  const launch = caps.resolveLaunchDir({
    root,
    recordedCwd: hints.recordedCwd,
    worktree: hints.worktree,
    isDir,
  })
  const dir = launch.effectiveCwd ?? launch.cwd
  return { root, cwd: isDir(dir) ? dir : root }
}

// Root under which each task's materialized attachment blobs live (cached across
// turns). Overridable for tests/containers; defaults to the OS temp dir.
// (Claude reads attached images from here via the adapter's --add-dir grant.)
const FILES_ROOT = process.env.LANDER_FILES_ROOT?.trim() || defaultFilesRoot()

// Where a hook body may keep durable state, per project. A NEW convention, not
// an existing one: the daemon's other per-project directory (attachments) lives
// under the OS temp dir, which is right for a cache and wrong for anything a
// hook is accumulating deliberately. Provided rather than left to a body to
// guess — the project root is the repository, where logs do not belong, and the
// server's data layout is not something the daemon knows.
const HOOK_STATE_ROOT =
  process.env.LANDER_HOOK_STATE_ROOT?.trim() ||
  path.join(homedir(), '.lander', 'hook-state')

function hookStateDir(slug: string): string {
  // The slug is the daemon's own (projectSlug strips everything but
  // [A-Za-z0-9._-]), but it reaches a path join, so refuse anything that could
  // walk out of the root rather than trusting provenance.
  const safe = /^[A-Za-z0-9._-]+$/.test(slug) && slug !== '.' && slug !== '..'
  return path.join(HOOK_STATE_ROOT, safe ? slug : 'unknown')
}

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
  caps: CAPS,
  resolveRunPaths,
  send,
  // Point LANDER_FILES_DIR at the task's persistent store every turn, so a file
  // attached on an earlier turn stays reachable via `lander file cat/ls`.
  resolveFilesDir: (msg) => taskFilesDir(FILES_ROOT, msg.project, msg.taskId),
  materialize,
  refreshUsage,
  defaultIdleMs: DEFAULT_IDLE_MS,
  onEmpty: () => drain.check(),
})

// The dev supervisor's drain handoff (daemon-watch.mjs sends SIGUSR2 on a daemon
// source edit): finish the runs we're riding, take no new ones, and exit once
// they're all done — so a code edit never interrupts an in-flight turn. SIGTERM
// still hard-kills as the max-drain cap.
// Fire ids whose hook host is alive right now. Held so a hook run counts as work
// for the drain and is killed with everything else — a hook host is not a
// `runManager` run, so without this a daemon told to hand off would see
// `runsHeld() === 0` and `process.exit(0)` straight through a running body,
// orphaning a detached process that still holds a live credential while the
// server waits out its timeout and the next sweep dispatches the same fire to
// the successor. Not hypothetical: daemon-watch sends SIGUSR2 on every
// `daemon/**` edit.
const hookRuns = createHookRuns()

const drain = createDrain({
  runsHeld: () => runManager.size() + hookRuns.held(),
  exit: () => {
    console.log('drained; exiting for handoff')
    process.exit(0)
  },
})

function onMessage(raw: string): void {
  let msg: ServerToDaemon
  try {
    msg = JSON.parse(raw) as ServerToDaemon
  } catch {
    return
  }
  try {
    handleMessage(msg)
  } catch (e) {
    // A synchronous throw in here would otherwise be uncaught inside the WS
    // message listener, killing the daemon and dropping every run it holds.
    //
    // But it must RESPOND, never merely swallow. A bare catch is strictly worse
    // than the crash it replaces: on a crash the server's drop() releases the
    // daemon's runs, unownedOpenRuns() finds them, and reconcileGrace() crashes
    // them after the 15s grace, so each task settles with an error and a retry
    // ask. Swallowing keeps the daemon connected, so the run stays owned, no
    // crash-grace fires, and — no host having been spawned — no idle watchdog
    // exists either: the task sits `riding` with an open ride forever.
    const err = e instanceof Error ? e.message : String(e)
    console.error(`daemon: error handling ${msg.type}:`, e)
    switch (msg.type) {
      case 'start-run':
        // Through runManager, so the settle-once gate and the run's release
        // both happen. See failRun.
        runManager.failRun(msg.runId, `daemon error: ${err}`)
        break
      case 'project-grant':
        // Otherwise the server's grantRequests entry hangs to its 15s timeout.
        send({
          type: 'project-grant-result',
          requestId: msg.requestId,
          ok: false,
          error: `daemon error: ${err}`,
          status: 500,
        })
        break
      case 'resume-from':
        // The one case with no server-side timeout: the server is waiting on a
        // replay that will now never come. Let the run fall to the crash grace
        // rather than look healthy.
        console.error(
          `daemon: resume-from failed for run ${msg.runId}; releasing it to the crash grace`,
        )
        runManager.failRun(msg.runId, `daemon error during resume: ${err}`)
        break
      case 'hooks-resolve':
        // Same reasoning as project-grant: the server is holding a correlated
        // request that would otherwise hang to its timeout.
        send({
          type: 'hooks-resolve-result',
          requestId: msg.requestId,
          ok: false,
          error: `daemon error: ${err}`,
          status: 500,
        })
        break
      case 'hook-run':
        // Belt for a synchronous throw before runHook's own .catch is attached
        // (resolveHooksCwd throws for an unknown slug). The run is released
        // here too, since the .finally never ran.
        hookRuns.release(msg.fireId)
        send({
          type: 'hook-run-result',
          requestId: msg.requestId,
          ok: false,
          error: `daemon error: ${err}`,
          status: 500,
        })
        break
      case 'interrupt':
      case 'ack':
        // Nothing is waiting on a reply for these, but they must not be silent.
        break
    }
  }
}

function handleMessage(msg: ServerToDaemon): void {
  switch (msg.type) {
    case 'start-run':
      if (drain.draining()) {
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
      // Every lookup in this block is keyed by a name that is now `string`, so
      // each one can miss. They were safe only while AgentKind was a closed
      // union; an unguarded miss here throws inside the WS message listener,
      // which is uncaught — killing the daemon and dropping every run it holds.
      const flowName = msg.flow ?? msg.agent
      const caps = flowName ? CAPS[flowName] : undefined
      // A project grant arrives outside any run, so there is no host to route it
      // through — the daemon calls the flow's hook in-process, exactly as it
      // called the adapter's method. Bundled flows are compiled-in TypeScript,
      // as trusted as the adapters they replace; third-party installation has to
      // re-decide this boundary before it opens.
      const onGrant = flowName ? FLOW_MODULES[flowName]?.onGrant : undefined
      const persist = caps?.projectGrants
        ? onGrant
          ? (input: { projectPath: string; rule: string }) =>
              onGrant(undefined, input)
          : // Optional-chained: reached when a flow declares projectGrants but
            // exports no onGrant, which for an adapter-less flow would be
            // `undefined.persistProjectGrant`.
            ADAPTERS[flowName as AgentKind]?.persistProjectGrant
        : undefined
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
      if (!persist) {
        send({
          type: 'project-grant-result',
          requestId: msg.requestId,
          ok: false,
          // Source the reason from the provider rather than branching on the
          // agent name; codex carries the exact current text, so this is
          // byte-identical. The generic fallback is dead until a third
          // non-granting provider exists.
          // `caps?` because this is the branch an UNKNOWN flow reaches — it has
          // no caps at all, making this the likeliest of the four sites to
          // deref undefined, not the least.
          error:
            caps?.projectGrantsUnsupportedReason ??
            `Project permission grants are not supported for ${flowName ?? 'unknown'} tasks.`,
          status: 400,
        })
        break
      }
      persist({ projectPath, rule: msg.rule })
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
    case 'hook-run': {
      // Refused while draining, unlike hooks-resolve: this one spawns a host
      // that may run for minutes, and a daemon on its way out must not accept
      // work it would have to abandon. The server treats the refusal as a hold —
      // no attempt counted, no report item — and retries once the successor is
      // primary, which is seconds away.
      //
      // This is the only mechanism, not a race-closer on top of one: the server
      // keeps no per-socket draining state and a SIGUSR2'd daemon never
      // re-registers, so its `primary` still points here for the whole handoff
      // window.
      if (drain.draining()) {
        send({
          type: 'hook-run-result',
          requestId: msg.requestId,
          ok: false,
          error: 'daemon draining; hook not run',
          status: 503,
        })
        break
      }
      // A fire already running here is not run again. Two live bodies for one
      // fire is a strictly stronger hazard than the retry-after-death that
      // bodies are asked to tolerate.
      if (hookRuns.has(msg.fireId)) {
        send({
          type: 'hook-run-result',
          requestId: msg.requestId,
          ok: true,
          report: { outcome: 'already-running', reports: [] },
        })
        break
      }
      const { root, cwd } = resolveHooksCwd(msg.project, msg.target)
      // Registered before the spawn so a shutdown in the gap still counts it;
      // the real kill replaces this as soon as the host exists.
      hookRuns.hold(msg.fireId)
      // `.catch` INSIDE the handler, like project-grant and hooks-resolve:
      // onMessage's try/catch covers only a synchronous throw, and a floating
      // rejection here would leave the server holding the exchange to its
      // timeout — the swallow that the note in onMessage calls strictly worse
      // than a crash.
      runHook(msg, {
        projectRoot: root,
        targetCwd: cwd,
        stateDir: hookStateDir(msg.project),
        onSpawn: (kill) => hookRuns.arm(msg.fireId, kill),
      })
        .then((report) =>
          send({ type: 'hook-run-result', requestId: msg.requestId, ok: true, report }),
        )
        .catch((e) =>
          send({
            type: 'hook-run-result',
            requestId: msg.requestId,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
            status: 500,
          }),
        )
        .finally(() => {
          // Released only once runHook has settled, which it does on the host's
          // `close` — so a host still tearing down still holds the drain.
          hookRuns.release(msg.fireId)
          drain.check()
        })
      break
    }
    case 'hooks-resolve': {
      // Read-only and answerable while draining: it spawns no run and holds
      // nothing, so a daemon on its way out can still answer one.
      const { root, cwd } = resolveHooksCwd(msg.project, msg)
      resolveHooks(gitExec, {
        root,
        cwd,
        ...(msg.trustRoot ? { trustRoot: msg.trustRoot } : {}),
        ...(msg.declare ? { declare: msg.declare } : {}),
        ...(msg.history ? { history: msg.history } : {}),
      })
        .then((resolution) =>
          send({
            type: 'hooks-resolve-result',
            requestId: msg.requestId,
            ok: true,
            resolution,
          }),
        )
        .catch((e) =>
          send({
            type: 'hooks-resolve-result',
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
// Hook hosts too: they are detached process groups this process spawned, and
// they are not runs, so runManager does not know about them.
function killChildren(): void {
  runManager.killChildren()
  hookRuns.killAll()
}
process.on('SIGTERM', () => {
  killChildren()
  process.exit(0)
})
process.on('SIGINT', () => {
  killChildren()
  process.exit(0)
})

// Graceful handoff: the dev supervisor sends SIGUSR2 on a daemon source edit
// instead of killing us (SIGUSR1 is reserved by Node for the inspector). The
// state machine (drain.ts) stops the watch timers, keeps only our riding runs,
// and exits once drained.
process.on('SIGUSR2', () => {
  if (drain.draining()) return
  console.log(`draining ${runManager.size()} run(s) before handoff`)
  drain.begin()
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
      draining: drain.draining(),
      runs: runManager.heldRunIds(),
      // Everything we can drive, so the server knows what it may dispatch. All
      // bundled at step 4; the scope envelope is here because resolution
      // precedence (bundled → user → project) is already committed to, and a
      // flat list would need a second wire change one step later.
      flows: announcedFlows(),
    })
    // Prime the server's snapshot: re-push the last one we hold (so a reconnect
    // re-fills the server cache immediately), then fetch a fresh one (the boot /
    // connect trigger; the TTL floor collapses a redundant fetch).
    if (USAGE_AGENT) {
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
