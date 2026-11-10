// The host daemon: supervises a flow-host subprocess per run and a hook-host
// subprocess per hook fire, and relays their results to the server over a
// WebSocket. It holds the project host paths (its own argv) and resolves each
// run's launch directory locally, so the server can stay host-agnostic and
// (later) move into a container. Phase 1: same host, same user, same credentials.
//
// Usage: node daemon/index.ts /path/to/project [/path/to/another ...]
//   env: LANDER_WS (server ws url, default ws://localhost:6181/daemon)
//        LANDER_DAEMON_TOKEN (must match the server's; read once at startup and
//          then deleted from the environment, so it is not inherited by the flow
//          hosts and agent children this process spawns — see server/secrets.ts)

import path from 'node:path'
import { ROOT, isInside, isSafePathSegment } from './paths'
import { realpath } from 'node:fs/promises'
import { projectDirs, projectSlug } from '../server/projects'
import {
  FLOW_MODULES,
  announcedFlows,
  providerCaps,
  type ProviderCaps,
} from './flows/index'
import { scrubProcessEnv } from '../server/secrets'
import type { TelemetryItem } from '../server/protocol'
import type {
  ServerToDaemon,
  RegisteredMessage,
  StartRunMessage,
  HooksResolveMessage,
  HookRunMessage,
  WatcherRunMessage,
  CheckoutHints,
  ProjectGrantMessage,
  RegisterMessage,
  AppActionMessage,
  AppLogMessage,
  AppsMessage,
  AppStatus,
  AppTouchMessage,
  AppStatusMessage,
  CheckoutCleanupFailedMessage,
  ReleaseCheckoutMessage,
  TelemetryMessage,
} from '../server/protocol'
import { createReply, type ReplyBody, type ReplyMessage } from './reply'
import { taskApiHeaders } from './task-api'
import { gitExec, resolveHooks } from './hooks'
import { createHookRuns, runHook } from './hook-run'
import { bundledWatcherMetas, runWatcher } from './watchers'
import { statSync } from 'node:fs'
import { createAppManager } from './app-manager'
import { appStatus, appUrl } from './apps'
import { createProjectOptions, type AppConfig } from './config'
import {
  checkoutPath,
  createTaskLocks,
  ensureCheckout,
  existingCheckout,
  removeCheckout,
  cleanUpAndRemoveCheckout,
} from './checkout'
import { homedir } from 'node:os'
import { createRunManager, type RunManagerMessage, type RunPaths } from './run'
import type { TaskApp } from './host-protocol'
import { createDrain } from './drain'
import { HOST_STOP_GRACE_MS } from './processes'
import { createWakeHold } from './power'
import {
  materializeAttachments,
  taskFilesDir,
  defaultFilesRoot,
  type MaterializedFiles,
} from './attachments'
import type { AttachmentRef } from '../server/protocol'

// Project host paths come from argv when the daemon is launched by hand, else
// from the same source as the server's (see projectDirs).
const fromArgv = process.argv.slice(2)
const servedDirs = (fromArgv.length ? fromArgv : projectDirs(process.env)).map((p) =>
  path.resolve(p),
)
if (!servedDirs.length) {
  console.error(
    'usage: node daemon/index.ts /path/to/project [more ...]  (or set PROJECT_DIRS)',
  )
  process.exit(1)
}
// Map each served slug to its host path; the server keys runs by slug and the
// daemon resolves the actual directory (decision 8).
const pathBySlug = new Map<string, string>()
for (const p of servedDirs) pathBySlug.set(projectSlug(p), p)

const WS_URL = process.env.LANDER_WS?.trim() || 'ws://localhost:6181/daemon'
const TOKEN = process.env.LANDER_DAEMON_TOKEN?.trim() || ''
// Drop lander's own credentials from the environment now that TOKEN holds the
// one this process needs — it is a module const, reused by every reconnect, so
// nothing reads the variable again. Everything the daemon spawns inherits
// `{ ...process.env }` (the flow host, and through it the agent child), so
// without this the UI token reached every task's shell, where presenting it as
// `x-lander-ui-token` resolves as the trusted human on every route.
//
// Here rather than in daemon-watch.mjs: that supervisor spawns each daemon with its
// own env and must keep the value to hand to the successor across a drain
// handoff. Here rather than at the spawn sites: a new spawn site can forget a
// filter, but it cannot un-inherit what is no longer in the environment.
scrubProcessEnv()
// Flow capabilities needed before a per-turn host exists.
const CAPS = providerCaps()

let ws: WebSocket | null = null

function send(
  msg:
    | RunManagerMessage
    | RegisterMessage
    | TelemetryMessage
    | ReplyMessage
    | CheckoutCleanupFailedMessage
    | AppsMessage,
): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

// ── Usage ───────────────────────────────────────────────────────────────────
// The daemon owns the SCHEDULE for each flow's usage panel — the 60s TTL floor
// every trigger shares, the per-turn trigger, the boot/connect fetch, and the
// reset timer — because that schedule has to run when no run, and therefore no
// flow host, is alive. It does not own the CONTENT: what a snapshot is (where
// the numbers come from, the item mapping, and when to look again) belongs
// to each flow that declares usageSnapshot, reached through its out-of-turn
// onStatus hook. A provider that publishes nothing simply exports no hook and its
// panel stays empty.
const USAGE_TTL_MS = 60_000
type UsageSchedule = {
  items: TelemetryItem[] | null
  triedAt: number
  refreshing: boolean
  resetTimer: ReturnType<typeof setTimeout> | null
}
const usageByFlow = new Map<string, UsageSchedule>(
  Object.keys(CAPS)
    .filter((flow) => CAPS[flow].usageSnapshot)
    .map((flow) => [flow, { items: null, triedAt: 0, refreshing: false, resetTimer: null }]),
)

function pushUsage(flow: string): void {
  const items = usageByFlow.get(flow)?.items
  if (items)
    send({
      type: 'telemetry',
      flow,
      items,
    })
}

// The TTL counts from the last attempt, not the last success, so no trigger can
// hammer the endpoint, the keychain, or the CLI even while every attempt fails.
function refreshUsage(flow: string): Promise<void> {
  const s = usageByFlow.get(flow)
  if (!s) return Promise.resolve()
  if (Date.now() - s.triedAt < USAGE_TTL_MS) return Promise.resolve()
  if (s.refreshing) return Promise.resolve()
  s.refreshing = true
  return takeUsageSnapshot(flow, s)
    .then(() => {})
    .catch(() => {
      // A flow hook that throws must not take the daemon's schedule down with
      // it; the last snapshot stands until the next trigger.
    })
    .finally(() => {
      s.refreshing = false
    })
}

async function takeUsageSnapshot(
  flow: string,
  s: UsageSchedule,
): Promise<{ fullUntil?: string } | null> {
  const onStatus = FLOW_MODULES[flow].onStatus
  if (!onStatus) return null
  s.triedAt = Date.now()
  const snapshot = await onStatus()
  if (snapshot) {
    s.items = snapshot.items as TelemetryItem[]
    pushUsage(flow)
    scheduleUsageReset(flow, s, snapshot.refreshAt)
  }
  return snapshot
}

// A failed run whose flow reported no reset time of its own: look at the flow's
// usage now, past the TTL floor, since the last snapshot usually predates the
// turn that used a window up. A run that fails while another's look is still
// in flight shares it.
const fullChecks = new Map<string, Promise<string | undefined>>()
function usageFullUntil(flow: string): Promise<string | undefined> {
  const s = usageByFlow.get(flow)
  if (!s) return Promise.resolve(undefined)
  let check = fullChecks.get(flow)
  if (!check) {
    check = takeUsageSnapshot(flow, s)
      .then((snapshot) => snapshot?.fullUntil, () => undefined)
      .finally(() => fullChecks.delete(flow))
    fullChecks.set(flow, check)
  }
  return check
}

// Arm a one-shot refresh just after the flow says its windows reset, so the
// readout catches utilization dropping back without waiting for the next turn.
// Clamped to the TTL floor: a reset already in the past must not become a busy
// loop.
function scheduleUsageReset(
  flow: string,
  s: UsageSchedule,
  refreshAt: string | undefined,
): void {
  if (!refreshAt) return
  const at = Date.parse(refreshAt)
  if (!Number.isFinite(at)) return
  const delay = Math.max(at - Date.now(), USAGE_TTL_MS)
  if (s.resetTimer) clearTimeout(s.resetTimer)
  s.resetTimer = setTimeout(() => {
    s.resetTimer = null
    void refreshUsage(flow)
  }, delay)
  s.resetTimer.unref()
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// Per-project options from the lander config, re-read when the file changes —
// so turning a project's worktrees on or off applies from its next ride.
const projectOptions = createProjectOptions()

const DEFAULT_LEASE_MINUTES = 120
// Renewed by the server's sweep every 15 seconds while a ride is in progress.
const RIDE_HOLD_MS = 2 * 60_000
const APP_SWEEP_MS = 5_000

const leaseMs = (app: AppConfig) => (app.leaseMinutes ?? DEFAULT_LEASE_MINUTES) * 60_000
const LANDER_HOME = path.join(homedir(), '.lander')

const apps = createAppManager({
  registryFile: path.join(LANDER_HOME, 'apps.json'),
  logDir: path.join(LANDER_HOME, 'app-logs'),
  maxApps: () => projectOptions.maxApps(),
  stopGraceMs: HOST_STOP_GRACE_MS,
  resolveUrl: ({ project, checkout }) => {
    const root = pathBySlug.get(project)
    const app = root ? projectOptions.app(root) : undefined
    return app ? appUrl(app, checkout) : undefined
  },
})

// Create and remove for one task's checkout never interleave.
const checkoutLock = createTaskLocks()
const checkoutKey = (project: string, taskId: string) => `${project}\0${taskId}`

// Create the task's checkout before its run spawns, when the run launches in
// one. Undefined (nothing to wait for) otherwise.
function prepareRun(msg: StartRunMessage, paths: RunPaths): Promise<void> | undefined {
  if (!paths.checkout) return undefined
  return checkoutLock(checkoutKey(msg.project, msg.taskId), async () => {
    await ensureCheckout(paths.root, msg.taskId)
  })
}

// Removals in progress, counted by the drain like runs and hook hosts: a
// daemon on its way out must not exit halfway through `git worktree remove`.
let releasesHeld = 0

function releaseCheckout(msg: ReleaseCheckoutMessage): void {
  const root = pathBySlug.get(msg.project)
  if (!root) return
  // Whatever the config says now: the path is ours either way, and turning a
  // project's worktrees off must not strand the ones it already has.
  releasesHeld++
  void checkoutLock(checkoutKey(msg.project, msg.taskId), async () => {
    // Before cleanup, which may drop databases the app has open.
    await apps.stop(msg.project, msg.taskId).catch((e) => {
      console.error(`could not stop the app for ${msg.project}/${msg.taskId}:`, e)
    })
    return cleanUpAndRemoveCheckout(root, msg.taskId, projectOptions.cleanup(root))
  })
    .then(({ removed, cleanupError }) => {
      if (removed) console.log(`removed worktree for ${msg.project}/${msg.taskId}`)
      if (cleanupError) {
        console.error(`cleanup failed for ${msg.project}/${msg.taskId}: ${cleanupError}`)
        send({
          type: 'checkout-cleanup-failed',
          project: msg.project,
          taskId: msg.taskId,
          error: cleanupError,
        })
      }
    })
    .catch((e) => {
      console.error(
        `could not remove worktree for ${msg.project}/${msg.taskId}:`,
        e instanceof Error ? e.message : String(e),
      )
    })
    .finally(() => {
      releasesHeld--
      drain.check()
    })
}

// Resolve a start-run's launch directory from the project slug + cwd hint. The
// cwd rule (launch at root, or resume from the recorded cwd) belongs to the
// flow, and the daemon just launches where it says. It runs here rather than in
// the host because it stats directories on the daemon's own filesystem to make
// the call.
//
// A project that enables worktrees overrides all of that: the run launches in
// the task's own checkout, whatever the flow would have chosen (prepareRun
// creates it first). That is daemon policy, not a provider's, so the flows'
// resolvers never see it.
function resolveRunPaths(msg: StartRunMessage, caps: ProviderCaps): RunPaths {
  const root = pathBySlug.get(msg.project)
  if (!root) throw new Error(`daemon serves no project for slug ${msg.project}`)
  const app = runningApp(msg.project, msg.taskId)
  const withApp = app ? { app } : {}
  if (projectOptions.worktrees(root)) {
    const checkout = checkoutPath(root, msg.taskId)
    return { root, cwd: checkout, checkout, ...withApp }
  }
  const launch = caps.resolveLaunchDir({ root, recordedCwd: msg.recordedCwd, isDir })
  return { root, cwd: launch.cwd, ...withApp }
}

// Which checkout a hook resolution reads, or a watcher works in. The tree
// that matters is the one the target task is working in: its own checkout when
// it has one, otherwise wherever the same provider-owned resolveLaunchDir a run
// uses would launch it.
//
// It falls back to the project root twice over: for a flow the daemon does not
// know (a resolve can arrive for any task, including one whose flow this build
// has never heard of), and for a resolved directory that is no longer there.
// Answering from the root is the honest degradation — that tree's hooks are the
// project's — where answering from a missing directory would report "not a git
// repository" for a repository that plainly is one.
//
// The root travels with it because the recorded cwd is task-writable, so a
// directory being under the project root does not make it the project's tree:
// hook resolution checks that the two are the same repository before reading the
// target's, and a watcher confines itself to the root (handleWatcherRun).
function resolveTaskCwd(
  project: string,
  hints: CheckoutHints,
): {
  root: string
  cwd: string
} {
  const root = pathBySlug.get(project)
  if (!root) throw new Error(`daemon serves no project for slug ${project}`)
  // The task's own checkout, while there is one to read — which is why a
  // landed task's checkout outlives its pending `landed` fires.
  if (hints.taskId && projectOptions.worktrees(root)) {
    const checkout = existingCheckout(root, hints.taskId)
    if (checkout) return { root, cwd: checkout }
  }
  const caps = hints.flow ? CAPS[hints.flow] : undefined
  if (!caps) return { root, cwd: root }
  const { cwd } = caps.resolveLaunchDir({ root, recordedCwd: hints.recordedCwd, isDir })
  return { root, cwd: isDir(cwd) ? cwd : root }
}

const FILES_ROOT = process.env.LANDER_FILES_ROOT?.trim() || defaultFilesRoot()

// Where a hook body may keep durable state, per project. A NEW convention, not
// an existing one: the daemon's other per-project directory (attachments) lives
// under the OS temp dir, which is right for a cache and wrong for anything a
// hook is accumulating deliberately. Provided rather than left to a body to
// guess — the project root is the repository, where logs do not belong, and the
// server's data layout is not something the daemon knows.
const HOOK_STATE_ROOT =
  process.env.LANDER_HOOK_STATE_ROOT?.trim() ||
  path.join(LANDER_HOME, 'hook-state')

function hookStateDir(slug: string): string {
  // The slug is the daemon's own (projectSlug strips everything but
  // [A-Za-z0-9._-]), but it reaches a path join, so refuse anything that could
  // walk out of the root rather than trusting provenance.
  return path.join(HOOK_STATE_ROOT, isSafePathSegment(slug) ? slug : 'unknown')
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
  const res = await fetch(
    `${api}/api/${project}/attachments/${encodeURIComponent(ref.id)}`,
    { headers: taskApiHeaders(env) },
  )
  if (!res.ok)
    throw new Error(`attachment ${ref.id}: ${res.status} ${res.statusText}`)
  return new Uint8Array(await res.arrayBuffer())
}

// Materialize a run's attachments into its per-task files dir and build the
// prompt manifest. Bound to the start message's project/task and env identity.
async function materialize(
  msg: StartRunMessage,
): Promise<MaterializedFiles | undefined> {
  if (!msg.attachments?.length) return undefined
  const filesDir = taskFilesDir(FILES_ROOT, msg.project, msg.taskId)
  return materializeAttachments({
    filesDir,
    attachments: msg.attachments,
    fetchBytes: (ref) => fetchAttachmentBytes(msg.env, ref),
    run: msg.runId,
  })
}

// Held while we're riding anything, so an idle Mac doesn't sleep under a live
// turn and hand the idle watchdog a run that looks silent the instant it wakes.
const wake = createWakeHold()

const runManager = createRunManager({
  caps: CAPS,
  resolveRunPaths,
  prepare: prepareRun,
  send,
  // Point LANDER_FILES_DIR at the task's persistent store every turn, so a file
  // attached on an earlier turn stays reachable via `lander attachment cat/ls`.
  resolveFilesDir: (msg) => taskFilesDir(FILES_ROOT, msg.project, msg.taskId),
  materialize,
  refreshUsage,
  usageFullUntil,
  onEmpty: () => {
    drain.check()
    // onEmpty is a "one was removed" nudge, not a promise the map is empty, so
    // ask before dropping the assertion. A settled-but-unacked run still counts,
    // so an API outage keeps the assertion held until the server is back.
    if (runManager.size() === 0) wake.release()
  },
})

// The dev supervisor's drain handoff (daemon-watch.mjs sends SIGUSR2 on a daemon
// source edit): finish the runs we're riding, take no new ones, and exit once
// they're all done — so a code edit never interrupts an in-flight turn. SIGTERM,
// the max-drain cap, stops them instead.
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
  runsHeld: () => runManager.size() + hookRuns.held() + releasesHeld,
  exit: () => {
    console.log('drained; exiting for handoff')
    process.exit(0)
  },
})

let sweepingApps = false
setInterval(() => {
  if (sweepingApps || drain.draining() || exiting) return
  sweepingApps = true
  apps
    .sweep()
    .then(() => publishApps())
    .catch((e) => console.error('app sweep failed:', e instanceof Error ? e.message : String(e)))
    .finally(() => {
      sweepingApps = false
    })
}, APP_SWEEP_MS).unref()

const reply = createReply(send)

// Handle a message about one run. The server holds no reply open for these, so
// a throw is caught here rather than escaping the WebSocket listener and
// crashing the daemon along with every run it holds. When `fail` is set, the run
// is also settled as failed. Logging alone would be worse than the crash: the
// daemon stays connected, so the server keeps the run owned and no crash grace
// ever fires, and the task rides forever.
function forRun(
  msg: { type: string; runId: string },
  handle: () => void,
  { fail }: { fail: boolean },
): void {
  try {
    handle()
  } catch (e) {
    console.error(`daemon: error handling ${msg.type} for run ${msg.runId}:`, e)
    if (fail)
      runManager.failRun(
        msg.runId,
        `daemon error: ${e instanceof Error ? e.message : String(e)}`,
      )
  }
}

function onMessage(raw: string): void {
  let msg: ServerToDaemon | RegisteredMessage
  try {
    msg = JSON.parse(raw) as ServerToDaemon | RegisteredMessage
  } catch {
    return
  }
  switch (msg.type) {
    case 'start-run':
      return forRun(msg, () => startRun(msg), { fail: true })
    // No server-side timeout covers a resume: the server waits on a replay that
    // would never come, so a failed one settles the run.
    case 'resume-from':
      return forRun(msg, () => runManager.resumeFrom(msg.runId, msg.seq), {
        fail: true,
      })
    case 'interrupt':
      return forRun(msg, () => runManager.interrupt(msg.runId), { fail: false })
    case 'ack':
      return forRun(msg, () => runManager.ack(msg.runId), { fail: false })
    case 'project-grant':
      void reply('project-grant-result', msg.requestId, () => grantProject(msg))
      return
    case 'hooks-resolve':
      void reply('hooks-resolve-result', msg.requestId, () => resolveHooksFor(msg))
      return
    case 'app-status':
      void reply('app-status-result', msg.requestId, () => handleAppStatus(msg))
      return
    case 'app-action':
      void reply('app-action-result', msg.requestId, () => handleAppAction(msg))
      return
    case 'app-log':
      void reply('app-log-result', msg.requestId, () => handleAppLog(msg))
      return
    case 'app-touch':
      if (drain.draining()) return
      try {
        handleAppTouch(msg)
      } catch (e) {
        console.error(`app touch for ${msg.project}/${msg.taskId} failed:`, e)
      }
      return
    case 'hook-run':
      return runHookFire(msg)
    // Taken while draining too: a watcher only reads, and is bounded by its budget.
    case 'watcher-run':
      void reply('watcher-run-result', msg.requestId, () => handleWatcherRun(msg))
      return
    // Taken while draining too: it spawns no run, and the drain waits for it.
    case 'release-checkout':
      return releaseCheckout(msg)
    // Tell the dev supervisor the server has us registered, so it can drain the
    // daemon we replace (daemon-supervisor.mjs). Unavailable when nothing spawned
    // us with IPC, or once the supervisor has gone.
    case 'registered':
      if (!drain.draining()) publishApps(true)
      if (process.connected) process.send?.({ type: 'registered' })
      return
  }
}

function startRun(msg: StartRunMessage): void {
  if (drain.draining() || exiting) {
    // We're handing off; the server routes new runs to the fresh primary, so
    // this shouldn't arrive — but if it does, abort cleanly rather than start
    // work we'd interrupt at exit.
    send({
      type: 'done',
      runId: msg.runId,
      exitCode: 1,
      interrupted: false,
      stderr: `daemon ${exiting ? 'stopping' : 'draining'}; run not started`,
    })
    return
  }
  // Before the start, not after: the attachment path registers its run
  // asynchronously, so there is a window where nothing is held yet and a sleep
  // would land squarely in it.
  wake.hold()
  runManager.startRun(msg)
}

// From the registry rather than the port, so a turn never waits on it. An app
// still starting counts, because the agent should leave it alone either way.
function runningApp(project: string, taskId: string): TaskApp | undefined {
  try {
    const url = apps.runningUrl(project, appContext(project, taskId).key)
    return url ? { url } : undefined
  } catch (e) {
    console.error(`could not describe the app for ${project}/${taskId}:`, e)
    return undefined
  }
}

async function grantProject(
  msg: ProjectGrantMessage,
): Promise<ReplyBody<'project-grant-result'>> {
  const projectPath = pathBySlug.get(msg.project)
  if (!projectPath)
    return {
      ok: false,
      error: `daemon serves no project for slug ${msg.project}`,
      status: 404,
    }
  const flowName = msg.flow
  const caps = flowName ? CAPS[flowName] : undefined
  const onGrant = flowName ? FLOW_MODULES[flowName]?.onGrant : undefined
  if (!caps?.projectGrants || !onGrant)
    return {
      ok: false,
      // A flow may word its own refusal; one that doesn't, and a flow this
      // daemon doesn't know, get the generic reason.
      error:
        caps?.projectGrantsUnsupportedReason ??
        `Project permission grants are not supported for ${flowName ?? 'unknown'} tasks.`,
      status: 400,
    }
  // A project grant arrives outside any run, so there is no host to route it
  // through. Bundled flow hooks run in-process; loading third-party hooks would
  // require an isolation boundary.
  await onGrant(undefined, { projectPath, rule: msg.rule })
  return { ok: true }
}

// Read-only and answerable while draining: it spawns no run and holds nothing,
// so a daemon on its way out can still answer one.
async function resolveHooksFor(
  msg: HooksResolveMessage,
): Promise<ReplyBody<'hooks-resolve-result'>> {
  const { root, cwd } = resolveTaskCwd(msg.project, msg)
  const resolution = await resolveHooks(gitExec, {
    root,
    cwd,
    ...(msg.trustRoot ? { trustRoot: msg.trustRoot } : {}),
    ...(msg.declare ? { declare: msg.declare } : {}),
    ...(msg.history ? { history: msg.history } : {}),
  })
  return { ok: true, resolution }
}

function appContext(project: string, taskId: string) {
  const root = pathBySlug.get(project)
  if (!root) throw new Error(`daemon serves no project for slug ${project}`)
  const worktrees = projectOptions.worktrees(root)
  return {
    root,
    app: projectOptions.app(root),
    key: worktrees ? taskId : 'root',
    // Without its own worktree, a task in a worktree project has no app: the
    // root's env file would name a different checkout's port.
    checkout: worktrees ? existingCheckout(root, taskId) : root,
  }
}

async function describeApp(project: string, taskId: string): Promise<AppStatus | null> {
  const { app, key, checkout } = appContext(project, taskId)
  if (!app || !checkout) return null
  const status = await appStatus(app, checkout)
  const managed = apps.describe(project, key, status.listening)
  return { ...status, canStart: !!app.start, ...(managed ? { managed } : {}) }
}

const START_REFUSALS = {
  'already-running': 'The app is already running.',
  'port-in-use': 'Something else is already using the port.',
  'cannot-start': 'The app could not be started.',
}

async function handleAppAction(
  msg: AppActionMessage,
): Promise<ReplyBody<'app-action-result'>> {
  if (drain.draining() || exiting)
    return { ok: false, error: 'lander is restarting; try again', status: 503 }
  const { app, key, checkout } = appContext(msg.project, msg.taskId)
  if (!app) return { ok: false, error: 'this project has no app configured', status: 404 }
  return checkoutLock(checkoutKey(msg.project, key), async () => {
    if (msg.action !== 'start') await apps.stop(msg.project, key)
    if (msg.action !== 'stop') {
      if (!app.start) return { ok: false, error: 'no start command is configured', status: 400 }
      if (!checkout) return { ok: false, error: 'this task has no worktree', status: 409 }
      const result = await apps.start({
        project: msg.project,
        key,
        checkout,
        taskId: msg.taskId,
        command: app.start,
        leaseMs: leaseMs(app),
      })
      if (!result.ok)
        return { ok: false, error: result.error ?? START_REFUSALS[result.reason], status: 409 }
    }
    publishApps()
    return { ok: true, app: await describeApp(msg.project, msg.taskId) }
  })
}

function handleAppTouch(msg: AppTouchMessage): void {
  const { app, key } = appContext(msg.project, msg.taskId)
  if (!app) return
  if (msg.reason === 'ride') apps.hold(msg.project, key, RIDE_HOLD_MS)
  else apps.extend(msg.project, key, leaseMs(app))
}

let publishedApps = ''

function publishApps(force = false): void {
  const list = apps
    .list()
    .filter((a) => a.state !== 'exited')
    .map((a) => ({ project: a.project, taskId: a.taskId }))
  const text = JSON.stringify(list)
  if (!force && text === publishedApps) return
  publishedApps = text
  send({ type: 'apps', apps: list })
}

function handleAppLog(msg: AppLogMessage): ReplyBody<'app-log-result'> {
  const { key } = appContext(msg.project, msg.taskId)
  return { ok: true, text: apps.logTail(msg.project, key) }
}

async function handleAppStatus(
  msg: AppStatusMessage,
): Promise<ReplyBody<'app-status-result'>> {
  return { ok: true, app: await describeApp(msg.project, msg.taskId) }
}

async function handleWatcherRun(
  msg: WatcherRunMessage,
): Promise<ReplyBody<'watcher-run-result'>> {
  const { root, cwd } = resolveTaskCwd(msg.project, msg)
  // The recorded cwd is task-writable, and a symlink under the project root can
  // point anywhere, so a watcher works in it only if it really is under the root.
  const [realRoot, realCwd] = await Promise.all([realpath(root), realpath(cwd)])
  const confined = realCwd === realRoot || isInside(realRoot, realCwd) ? cwd : root
  const outcome = await runWatcher(
    msg.watcher,
    { cwd: confined },
    msg.args,
    msg.prevState,
    msg.timeoutMs,
  )
  return { ok: true, outcome }
}

function runHookFire(msg: HookRunMessage): void {
  let held = false
  const run = async (): Promise<ReplyBody<'hook-run-result'>> => {
    // Refused while draining, unlike hooks-resolve: this one spawns a host that
    // may run for minutes, and a daemon on its way out must not accept work it
    // would have to abandon. The server treats the refusal as a hold, with no
    // report item, and retries on whichever daemon is primary by then. One can
    // still reach us in the moment between the drain starting and our draining
    // `register` reaching the server.
    if (drain.draining() || exiting)
      return {
        ok: false,
        error: `daemon ${exiting ? 'stopping' : 'draining'}; hook not run`,
        status: 503,
      }
    // A fire already running here is not run again. Two live bodies for one
    // fire is a strictly stronger hazard than the retry-after-death that bodies
    // are asked to tolerate.
    if (hookRuns.has(msg.fireId))
      return { ok: true, report: { outcome: 'already-running', reports: [] } }
    const { root, cwd } = resolveTaskCwd(msg.project, {
      ...msg.target,
      taskId: msg.target.id,
    })
    // Registered before the spawn, and synchronously with this message, so a
    // shutdown in the gap still counts it and a duplicate fire finds it held;
    // the real kill replaces this as soon as the host exists.
    hookRuns.hold(msg.fireId)
    held = true
    const report = await runHook(msg, {
      projectRoot: root,
      targetCwd: cwd,
      stateDir: hookStateDir(msg.project),
      onSpawn: (kill) => hookRuns.arm(msg.fireId, kill),
    })
    return { ok: true, report }
  }
  void reply('hook-run-result', msg.requestId, run).finally(() => {
    // Released once runHook has settled, which it does on the host's `close`
    // (so a host still tearing down holds the drain), and after the reply is
    // sent (so a drain exit can't beat it out).
    if (!held) return
    hookRuns.release(msg.fireId)
    drain.check()
  })
}

// On our own termination (decision 2 aborts in-flight turns anyway), take no
// new work and stop what we hold. Runs get a graceful stop, which lets a
// SIGTERMed agent end background work of its own outside its host's process
// group, and we wait for their hosts to close so that stop's SIGKILL fallback
// can still fire — though not past STOP_WAIT_CAP_MS, so a host that never
// reports closing can't keep us running beside our successor. Hook hosts are
// not runs, so runManager does not know about them; we kill their detached
// process groups outright.
const STOP_WAIT_CAP_MS = 3 * HOST_STOP_GRACE_MS
let exiting = false
function stopChildrenAndExit(): void {
  exiting = true
  hookRuns.killAll()
  setTimeout(() => process.exit(0), STOP_WAIT_CAP_MS).unref()
  // A draining daemon's apps now belong to its replacement.
  const stoppingApps = drain.draining()
    ? Promise.resolve()
    : apps.stopAll().catch((e) => console.error('could not stop every app:', e))
  void Promise.all([runManager.stopAll(), stoppingApps]).then(() => process.exit(0))
}
process.on('SIGTERM', stopChildrenAndExit)
process.on('SIGINT', stopChildrenAndExit)

// Graceful handoff: the dev supervisor sends SIGUSR2 on a daemon source edit
// instead of killing us (SIGUSR1 is reserved by Node for the inspector). Once
// draining, start-run and hook-run are refused, and drain.ts exits as soon as no
// run or hook fire is held.
process.on('SIGUSR2', () => {
  if (drain.draining()) return
  console.log(`draining ${runManager.size()} run(s) before handoff`)
  drain.begin()
  // Re-register as draining, so the server routes no new work here even if it
  // still has us as primary.
  sendRegister()
})

function sendRegister(): void {
  send({
    type: 'register',
    projects: [...pathBySlug.keys()].map((slug) => ({ slug })),
    // Tell the server whether we're handing off (so it routes no new runs to us)
    // and exactly which in-flight runs we still hold, so it resumes each only on
    // its real owner — and a reconnect mid-drain reclaims our runs instead of
    // losing them to the fresh primary.
    draining: drain.draining(),
    runs: runManager.heldRunIds(),
    // Everything we can drive, so the server knows what it may dispatch. Every
    // flow is bundled today; the scope envelope leaves room for user- and
    // project-scoped flows without another wire change.
    flows: announcedFlows(),
    watchers: bundledWatcherMetas(),
  })
}

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
    runManager.setServerLinked(true)
    sendRegister()
    // Prime the server's snapshot: re-push the last one we hold (so a reconnect
    // re-fills the server cache immediately), then fetch a fresh one (the boot /
    // connect trigger; the TTL floor collapses a redundant fetch).
    for (const flow of usageByFlow.keys()) {
      pushUsage(flow)
      void refreshUsage(flow)
    }
  })
  sock.addEventListener('message', (ev) => onMessage(String(ev.data)))
  sock.addEventListener('close', () => {
    if (ws === sock) ws = null
    runManager.setServerLinked(false)
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
