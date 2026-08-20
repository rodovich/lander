import { Hono, type Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { serve } from '@hono/node-server'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  rename,
  stat,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyUpdate, applyDone, wedgeForRetry } from './apply'
import { applyStatePatch } from './flowstate'
import { isAgentKind } from './agent'
import {
  attachDaemonServer,
  daemonConnected,
  daemonServes,
  daemonSlugs,
  sendToDaemon,
  openRunChannel,
  closeRunChannel,
  requestResume,
  requestProjectGrant,
} from './daemon'
import type {
  AgentKind,
  HookSelector,
  RevivedMarker,
  StartRunMessage,
  TelemetryItem,
} from './protocol'
import {
  readTasks as readTasksStore,
  readTask as readTaskStore,
  writeTask as writeTaskStore,
  mutateTask as mutateTaskStore,
} from './store'
import { parseProjects, type Project } from './projects'
import {
  publicTask,
  taskSummary,
  taskFlow,
  latestUpdateAt,
  recordStatusTransition,
  recordArtifactOnMessage,
  turnAttachments,
  deliverQueuedBatch,
  worktreeName,
  applyRelaunch,
  applyRetryRecovery,
  applyDueMessages,
  taskSessionId,
  setTaskSessionId,
  taskTurnContext,
  setTaskTurnContext,
  armScheduledRelaunch,
  startRide,
  closeRide,
  openRide,
  pushUserItem,
  pushFlowItem,
  pushEventItem,
  userItems,
  promptItems,
  eventItems,
  recordAssistantError,
  recordRideEnded,
  type ScheduledMessage,
  type RepeatSpec,
  type Ride,
  type Item,
  pushHookMessageItem,
  acceptHookAction,
  freshHookFire,
  type PendingHook,
  type HookAction,
} from './tasks'
import {
  saveAttachment,
  readAttachmentMeta,
  readAttachmentBytes,
  deleteAttachment,
  sanitizeName,
  isAttachmentId,
  AttachmentTooLargeError,
  MAX_ATTACHMENT_BYTES,
  type Attachment,
} from './attachments'
import {
  isArtifactName,
  upsertArtifact,
  MAX_ARTIFACT_BYTES,
  type Artifact,
} from './artifacts'
import {
  createAsk,
  wireAsk,
  answerAsk,
  answerDelivery,
  chosenOption,
  withdrawOpenAsks,
  validateAskForm,
  nextAskId,
  type Ask,
  type AskForm,
} from './asks'
import { LEGACY_FLOW, flowCaps, flowRegistry, isAnnouncedFlow } from './flows'
import {
  approveHookPairs,
  effectiveApprovals,
  isSafeTrustRoot,
  pairKey,
  readHooksStore,
  resolveProjectHooks,
  revokeHookPairs,
  selectorsFor,
  setTrustRoot,
  taskCheckout,
} from './hooks'
import { readHookCredential, hookCredentialFor, HookRefusal } from './hook-runs'
import { dispatchPendingHooks, hookDispatchInFlightFor } from './hook-dispatch'
import { generateTitle } from './title'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LANDER_BIN_DIR = path.join(ROOT, 'bin')

// Everything this installation persists — per-project task dirs, the UI token —
// lives under here. ./data in the checkout normally; LANDER_DATA_ROOT moves it,
// which is how the test suite keeps its scratch project out of the developer's
// live data dir (the suite recursively deletes its own root at teardown, and an
// interrupted run would otherwise strand a task dir inside the repo).
const DATA_ROOT = process.env.LANDER_DATA_ROOT
  ? path.resolve(process.env.LANDER_DATA_ROOT)
  : path.join(ROOT, 'data')

const PROJECTS = parseProjects(DATA_ROOT, process.env, process.cwd())
const PROJECT_BY_SLUG = new Map<string, Project>(
  PROJECTS.map((p) => [p.slug, p]),
)
const LEGACY_AGENT: AgentKind = 'claude'
// The configured default flow, read ONCE at boot — a task must serve the
// provider it was created with, not re-resolve the environment on every read
// (which is what DEFAULT_NEW_TASK_AGENT, now superseded, guaranteed). Its
// VALIDATION, though, is deferred to each request (resolveNewTaskFlow): at boot
// no daemon has registered, so a boot-time registry check would permanently
// degrade a valid LANDER_FLOW=open-pr to claude and warn about it wrongly.
//
// LANDER_AGENT is still honored as the fallback name, so an existing
// configuration keeps working.
const DEFAULT_NEW_TASK_FLOW = (
  process.env.LANDER_FLOW ??
  process.env.LANDER_AGENT ??
  ''
)
  .trim()
  .toLowerCase()
// Fires on the flow's declared task-grant capability, not on a provider name —
// an open-pr task declares the same `false` and would otherwise be told it was
// Codex.
const TASK_ALLOW_UNSUPPORTED_WARNING =
  'Saved for parity; this flow does not honor task allow rules yet'

// Daemon split: runs are driven by the host
// daemon over a WebSocket — the server holds task state, drives the queue, and
// serves the API/UI, but never spawns a process, touches a pid, or parses
// stream-json. The daemon authenticates its WS upgrade with DAEMON_TOKEN.
const DAEMON_TOKEN =
  process.env.LANDER_DAEMON_TOKEN?.trim() ||
  process.env.LANDER_UI_TOKEN?.trim() ||
  ''

// A task's id: a short, URL-safe nanoid-style token, distinct from the provider
// session id (see Task.sessionId). Chars are drawn from
// a 64-symbol alphabet, so `& 63` over random bytes is uniform. Tasks refer to
// each other by this id; it's the filename, the URL segment, the LANDER_TASK env,
// and the x-lander-task header.
const ID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
function newTaskId(): string {
  const bytes = randomBytes(10)
  let id = ''
  for (let i = 0; i < bytes.length; i++) id += ID_ALPHABET[bytes[i] & 63]
  return id
}

// Validates a task id arriving from an untrusted source (URL segment, header,
// await list) before it's used to build a filesystem path. Matches both the
// nanoid alphabet above and the uuids that legacy tasks are still keyed by; the
// length bound and the closed character class (no `/` or `.`) keep it path-safe.
const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/

type Task = {
  // The task's own id (a short nanoid; legacy tasks carry the uuid they were
  // keyed by — backfilled from the filename, see backfillIds). Always equals the
  // task's filename stem.
  id: string
  // The provider used for this task. LEGACY: written only for the claude and
  // codex flows, so an old daemon can still drive them (StartRunMessage.agent).
  // Never written for a task created with any other flow, and never rewritten
  // once `flow` is set — backfillAgents is gated on that. Read through
  // taskFlow(), never directly.
  agent?: AgentKind
  // The driver flow for this task. Absent on every task created before step 4,
  // which is why taskFlow() is a permanent union-read over both fields rather
  // than a migration: nothing rewrites pre-flip tasks, so the fallback is
  // load-bearing forever (the precedent sessionId/turnContext set in step 1).
  flow?: string
  // Opaque per-task configuration handed to the flow as ctx.task.flowConfig and
  // echoed on start-run. The server stores and forwards it and never interprets
  // it; it validates shape (a JSON object) and size only.
  flowConfig?: Record<string, unknown>
  // The provider session id backing this task's turns, reported by the daemon on
  // the first turn and persisted by the server (see SessionMessage /
  // reduceRunWs). Passed to the daemon each turn so it can resume the same
  // provider session. Decoupled from `id` so a task can later run multiple or
  // fresh sessions. Absent until the first turn reports one.
  sessionId?: string
  title: string
  status: string
  // ONE-SHOT marker: what an incoming message changed out from under this task —
  // the notable status it was pulled out of (stamped by recordStatusTransition,
  // the funnel every revival route crosses) and/or a rest wakeup the message
  // cleared (stamped by the /messages endpoint, since riding↔resting isn't a
  // crossing that funnel sees). It exists because the revived session's own last
  // act was `lander wedge`/`lander land`/`lander rest` and nothing else in the
  // next turn contradicts that memory. runTurn forwards it on start-run and the
  // daemon renders it as a one-sentence prompt block; the queue drain that
  // launches that run clears it under the same lock (see driveTask), so it rides
  // exactly the one turn it belongs to.
  revived?: RevivedMarker
  createdAt: string
  // Drives the sidebar sort order. Bumped only on meaningful turn boundaries —
  // when a user message is sent, when the assistant begins its reply, when the
  // agent finishes, and on a status or rename event — never on the per-chunk
  // streaming churn in between. Falls back to createdAt for tasks saved before
  // this field existed.
  updatedAt: string
  // ISO timestamp of the latest completed update (message/event) the viewer has
  // caught up to; drives the UI's unseen-update dot. Set to creation time on a
  // new task, advanced monotonically by the /seen endpoint as the viewer reads,
  // and backfilled at startup for tasks saved before this field existed.
  seenAt?: string
  allowEdits: boolean
  // The id of the task that spawned this one (`lander launch`), or absent
  // for tasks a human started from the UI. Records provenance — the same
  // relationship the opening message's "Launched by" backlink shows in prose —
  // in a form the server can check: it gates `lander land <id>`, which lets a task
  // wind down only the tasks it launched, not arbitrary ones. Absent on tasks
  // saved before this field existed (treated as "no known spawner").
  spawnedBy?: string
  // Per-task secret minted at creation and injected into the agent's process as
  // LANDER_TOKEN. The `lander` CLI sends it back as the X-Lander-Token header so
  // the server can authenticate which task made a request — used to cap the
  // permissions a task may grant to one it spawns to its own. Never returned
  // over HTTP (see publicTask), so one task can't read another's token. Absent
  // on tasks saved before this field existed; backfilled on the next run.
  token?: string
  // Extra permission rules granted from the UI's "allow in task" action; passed
  // to Claude as --allowedTools on every future turn for this task. Absent on
  // tasks saved before this field existed — treat undefined as empty.
  allow?: string[]
  // The unified item log (v2 storage): messages, tool calls, lifecycle events, and
  // asks, in one flat ordered array (see docs/conversation-model.md). Replaces the
  // old parallel messages[]/events[]/asks[], and is what publicTask serves.
  items: Item[]
  // Rides: one record per run (agent turn) this task has driven, opened when the
  // run is handed to the daemon and closed when it finishes. `endedAt`-less ⇒ the
  // ride is open (the task is actively riding). Absent on tasks that predate rides.
  rides?: Ride[]
  // Storage format stamp; every record carries `2` (rides + items). Kept as the
  // marker a future format change would key its migration off — the v1 reader that
  // used to fill it in on read is gone, the backlog having been converted.
  shape?: number
  // Named output slots this task has published (`lander artifact put`), latest
  // version only — the slot registry, upserted by name. Each points at its
  // current blob in the project's attachmentsDir (shared with input attachments);
  // republishing a name mints a fresh blob and supersedes the old. The generating
  // flow message item also carries a point-in-time ref, but this is the source of
  // truth for the current version, and downloads resolve against it by name.
  // Absent on tasks that have published none.
  artifacts?: Artifact[]
  // Follow-up prompts sent while a run was in flight, awaiting their turn.
  // Persisted so they survive a server restart; drained by driveTask when the
  // current run finishes — the whole queue joins into one turn (see driveTask).
  // Absent on tasks saved before this field existed — treat undefined as empty.
  queued?: string[]
  // Messages addressed to this task with a deferred delivery, sent by another
  // task via `lander send --date/--time/--await`. Each fires when its trigger is
  // met — a time (`deliverAt`) and/or a condition (`waitFor`, ids that must all
  // land), whichever comes first when both are set. The scheduler then appends
  // it as a user message, queues it, and drives the task, exactly as an immediate
  // send would, then drops it. The text already carries its sender backlink.
  // Absent when none are pending.
  // `relaunch` marks a `lander relaunch --date/--time/--await` deferral: on
  // delivery the scheduler seals task.sessionId and records a 'relaunched' event
  // before appending this message, so the delivering turn mints a fresh assistant
  // session — the deferred analog of the immediate /relaunch endpoint. The seal
  // happens at the trigger, not at call time, so the old session stays live until
  // then. `repeat` rides a `--interval` relaunch and re-arms the next occurrence
  // on each delivery. See ScheduledMessage in tasks.ts.
  scheduledMessages?: ScheduledMessage[]
  // ISO timestamp a scheduled task is set to launch. Set at creation via
  // `--date`/`--time`, or later via `lander rest` to re-sleep a running task;
  // the task rests until the scheduler reaches this time, which clears the
  // field, records a "launched" event, and drives the queue (a deferred new
  // task's opening message, or a generated "Resumed at …" prompt for a rested
  // one). May coexist with `waitingFor`, in which case whichever fires first
  // launches the task. Also dropped by an incoming message that wakes the task
  // early (see the /messages handler) and by landing (recordStatusTransition) —
  // both leave nothing for a timer to come back to. Absent on un-scheduled tasks.
  scheduledFor?: string
  // Task ids this task is resting on (`lander new/rest --await`). The scheduler
  // launches the task once every one has reached terminal "landed" — a missing
  // id (archived/deleted) counts as satisfied so a vanished dependency can't
  // strand the waiter. Coexists with `scheduledFor` as an OR fallback. Cleared
  // on launch, alongside scheduledFor, and on landing — but NOT by a message
  // that wakes the task early, since a dependency on siblings outlives that.
  // Absent when not awaiting.
  waitingFor?: string[]
  // Transient flag set when a task is read from the project's archive dir, so
  // the UI can mark archived rows and offer "Restore" instead of "Archive". Not
  // persisted: a task's location on disk (archived/ vs tasks/) is the source of
  // truth, and archiving moves the file rather than setting a field.
  archived?: boolean
  // The id of the run the daemon is streaming onto this task, and the seq of the
  // last update folded in (the run cursor). Set when a turn is handed to the
  // daemon, cleared when the run is fully reduced. Because the daemon outlives
  // this server and holds the run's replay buffer, these let a fresh process
  // reattach to a still-live run and resume reducing from the last applied seq.
  // Internal — stripped from the public task (see publicTask). Absent when no
  // run is in flight.
  runId?: string
  runCursor?: number
  // Set when a run wedged on an assistant error (a non-zero exit that wasn't a
  // deliberate interrupt — see applyDone), cleared when the task next starts a
  // turn. Drives the UI's retry affordance below a wedged conversation, and
  // tells a retry how to recover. `committed` is our proxy for whether the
  // failed turn's prompt(s) actually reached the provider session: true if the
  // run had begun streaming a reply (so the agent had accepted and recorded the
  // user turn), false if it errored before any output. A retry nudges the session
  // to continue when committed (re-sending would duplicate the user turn) and
  // re-sends the un-received `prompts` when not. `resetsAt` is set only
  // when the wedge was a session-limit rejection (from the run's
  // `rate_limit_event`): the ISO time the limit lifts, at which point a retry
  // schedules a wakeup for then instead of firing immediately into the same wall.
  // Absent on a task wedged any other way (e.g. the agent's own `lander wedge`),
  // so no button shows there.
  retry?: { committed: boolean; prompts: string[]; resetsAt?: string }
  // Set when the background title generation at creation failed (the haiku call
  // errored or returned nothing), so the task is still showing its placeholder
  // name. driveTask retries naming on the task's next wakeup — a user follow-up
  // or a scheduled/awaited launch — and clears this once naming succeeds. Any
  // manual rename clears it too, so a later retry never overrides the user's
  // chosen name. Absent on tasks that were named on the first try.
  titlePending?: boolean
  // The dynamic per-turn context block (git snapshot, live permission grants —
  // see the adapter's buildTurnContext) most recently delivered to this task's
  // provider session, as the daemon announced it (turn-context message). Kept
  // separate from the user messages so the UI never renders it; its job is to be
  // the baseline the daemon compares the next turn's freshly built block
  // against, appending (and re-announcing) only on change. Cleared alongside
  // sessionId by sealForRelaunch — a fresh session must get the full block
  // again. Absent for providers without a context builder (Codex) and on tasks
  // saved before this field existed.
  turnContext?: string
  // ── Task hooks ────────────────────────────────────────────────────────────
  // Fires the trigger funnel recorded and the dispatcher has not finished — one
  // per status crossing and per ride end, capped at MAX_PENDING_HOOKS. Cleared
  // only when every hook declared for a fire has reported, so an interrupted
  // dispatch is retried; the fire id is what makes that retry safe. Absent on a
  // task that has never crossed anything, which is every task before this
  // existed.
  pendingHooks?: PendingHook[]
  // The counter behind the fire id. Persisted so it cannot restart and mint an
  // id that collides with one a pruned action record still refers to.
  hookFireSeq?: number
  // When a human last touched this task, which is what resets the bound on the
  // actions a hook may take against it. Stamped by every UI-principal route, not
  // just `/messages`: a human who only answers asks and un-wedges from the kebab
  // is contacting the task just as unmanufacturably.
  hookActionsResetAt?: string
  // The actions lander accepted on a hook's behalf against this task. Both the
  // runaway bound and the retry dedupe read it — they are the same record, since
  // a counter keyed by (hook, target) is a set of accepted actions with its size
  // taken. Server-internal: stripped from publicTask, because without the reset
  // stamp beside it the list cannot answer the only question it exists for.
  hookActions?: HookAction[]
  // The working directory the previous turn ended in, recorded by the Stop hook
  // (see ClaudeAdapter / `lander record-cwd`). Each turn is a fresh `claude`
  // process; without this it always restarts at the project root, so a directory
  // the agent moved into during a turn — most notably a git worktree it entered
  // (EnterWorktree) — would be lost the moment the turn ends. runTurn passes it
  // to the daemon as a hint, and the daemon resolves the next turn's launch dir
  // from it, falling back to the project root when unset or no longer present.
  // Named for the hook's `cwd` payload (which carries no worktree-specific
  // field); a worktree is just one kind of cwd. Absent until the first turn
  // completes.
  cwd?: string
  // The absolute path to this session's transcript JSONL, from the same Stop
  // hook payload. Stored alongside cwd so the session file can be located
  // directly rather than re-deriving it from the launch directory. Absent until
  // the first turn completes.
  transcriptPath?: string
  // The name of the git worktree the agent is currently working in, set by a
  // provider hook such as Claude's EnterWorktree PostToolUse hook
  // (`lander record-worktree`) and cleared by the matching exit hook
  // (`lander clear-worktree`). While set, the daemon gives providers with real
  // worktree support their worktree flag; providers without it resume from
  // Task.cwd. Absent when the task isn't in a worktree.
  worktree?: string
  // The flow's opaque durable state, folded here from `state-patch` batches by
  // applyStatePatch. Convention (flow-inversion.md §Durable state): it records the
  // flow's decisions, identities, and user-visible progress — the PR number, the
  // CI run id, the approved message text, the phase — while bulk/derivable data
  // goes to scratch or artifacts. The server never interprets it; it rides back
  // out to the flow on start-run (StartRunMessage.flowState) and is cleared on
  // relaunch (sealForRelaunch). Stripped from the public task (publicTask).
  // Absent until a flow first writes it — no producer exists in step 1.
  flowState?: Record<string, unknown>
  // The revision counter applyStatePatch stamps, incremented once per applied
  // `state-patch` op batch. Used to dedupe an idempotent replay of buffered
  // patches on resume-from once a producer exists. Absent until the first write.
  flowStateRev?: number
}

// Bind the generic task store (server/store.ts) to the concrete Task type, so
// the rest of the server keeps the same typed call sites.
const readTasks = (dataDir: string) => readTasksStore<Task>(dataDir)
const readTask = (dataDir: string, id: string) => readTaskStore<Task>(dataDir, id)
const writeTask = (file: string, task: Task) => writeTaskStore(file, task)
const mutateTask = (file: string, fn: (task: Task) => void) =>
  mutateTaskStore(file, fn)

async function setTitle(
  dataDir: string,
  id: string,
  title: string,
): Promise<void> {
  const file = path.join(dataDir, `${id}.json`)
  // Through mutateTask so the title write serializes with (and can't clobber)
  // the streaming reducer running on the opening turn.
  await mutateTask(file, (task) => {
    // A manual rename (which records a 'renamed' event) wins over a late-arriving
    // generated name — the user's choice stands. Guards the narrow window between
    // a rename and a generation that was already in flight.
    if (eventItems(task).some((e) => e.eventKind === 'renamed')) return
    task.title = title
    // Naming succeeded, so a prior failure no longer needs retrying on the next
    // wakeup (see ensureTitle / driveTask).
    delete task.titlePending
    // This is the first generated name for a task created untitled: fill it into
    // the creation event (a launch, or a "scheduled" event for a deferred task)
    // rather than recording it as a rename.
    const created = eventItems(task).find(
      (e) => e.eventKind === 'launched' || e.eventKind === 'scheduled',
    )
    if (created && !created.title) created.title = title
  })
}

// Generate a name for a still-untitled task in the background and record it via
// setTitle. On failure, flag the task `titlePending` so its next wakeup retries
// (driveTask), unless the user has meanwhile named it themselves (a 'renamed'
// event) — in which case the flag is left off and their name stands. Naming must
// never hold up a turn, so callers fire-and-forget this.
async function ensureTitle(
  project: Project,
  id: string,
  source: string,
): Promise<void> {
  const next = await generateTitle(project.path, source)
  if (next) {
    await setTitle(project.dataDir, id, next)
    return
  }
  const file = path.join(project.dataDir, `${id}.json`)
  await mutateTask(file, (t) => {
    if (!eventItems(t).some((e) => e.eventKind === 'renamed')) t.titlePending = true
  }).catch(() => {})
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Wait (up to timeoutMs) for a daemon serving this project's slug to be
// connected. Normally already true — dev launches the daemon with the server —
// so the common path returns immediately; the wait only matters at boot or right
// after a daemon restart. Returns whether one is serving by the deadline.
async function awaitDaemonServing(
  slug: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!daemonServes(slug) && Date.now() < deadline) await sleep(200)
  return daemonServes(slug)
}

// Stop a turn so a riding task can be wedged out from under the agent: ask the
// daemon to interrupt the run. It SIGKILLs the child and emits a clean
// done{interrupted:true}, which reduceRunWs folds in — finalizing whatever
// partial reply streamed without surfacing a crash. Best effort: a run that has
// already finished is a no-op on the daemon side.
function interruptRun(_project: Project, runId: string): void {
  sendToDaemon({ type: 'interrupt', runId })
}

// Run one agent turn on the host daemon and reduce its streamed updates onto the
// task. The server hands a provider-neutral run intent to the daemon over the WS
// (start-run); the daemon owns provider argv, the agent child, and the stream.
// Because the daemon outlives the server, a server restart mid-turn doesn't stop
// the agent — the fresh process reattaches over the WS and resumes from the
// persisted cursor (see driveTask / recoverQueues). The daemon reports the
// provider session on the first turn and resumes it after, keyed by the
// `sessionId` hint below.
// Marks "riding" and records the runId so a reattach can find it.
async function runTurn(
  project: Project,
  id: string,
  prompt: string,
  runId: string,
  attachments: Attachment[] = [],
  // The one-shot revival marker, handed in by the caller rather than read off the
  // task here: the drain that produced this turn already cleared it under its
  // lock (that's what makes it one-shot), so by now it is gone from the record.
  revived?: RevivedMarker,
): Promise<'done' | 'crashed'> {
  const file = path.join(project.dataDir, `${id}.json`)
  let task: Task
  try {
    task = JSON.parse(await readFile(file, 'utf8')) as Task
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await mutateTask(file, (t) => {
      recordAssistantError(
        t,
        `error running assistant: ${message}`,
        new Date().toISOString(),
      )
    }).catch(() => {})
    return 'crashed'
  }

  // The token the in-task `lander` CLI sends back to authenticate as this task.
  // Backfilled for tasks created before tokens existed.
  const token = task.token ?? randomUUID()
  // The flow to drive this turn, derived from the FLOW NAME — never from
  // task.agent, which backfillAgents may have stamped on a legacy task.
  const flow = taskFlow(task)
  // `agent` rides along only when the flow IS a legacy kind, so a daemon built
  // before `flow` existed keeps driving claude and codex. Omitting it for every
  // other flow is what stops such a daemon from silently running an unknown
  // flow as claude — it will report `unsupported flow` instead.
  const agent = isAgentKind(flow) ? flow : undefined
  const landerEnv = {
    PATH: `${LANDER_BIN_DIR}:${process.env.PATH ?? ''}`,
    // The base URL the daemon's agent (and the in-task CLI) use to reach this
    // server. Defaults to localhost; override with LANDER_PUBLIC_API when the
    // server is reached across a boundary (e.g. a container).
    LANDER_API:
      process.env.LANDER_PUBLIC_API?.trim() || `http://localhost:${port}`,
    LANDER_PROJECT: project.slug,
    LANDER_TASK: id,
    LANDER_TOKEN: token,
  }

  // Wait briefly for a daemon serving this project to be connected (dev launches
  // it with the server, so it's normally already up); if none arrives, wedge the
  // turn with an error rather than hang.
  if (!(await awaitDaemonServing(project.slug))) {
    await mutateTask(file, (t) => {
      const at = new Date().toISOString()
      // Distinguish the two ways this fails: no daemon at all vs. a daemon that
      // is connected but doesn't serve this project's slug (a path/slug mismatch
      // between how the daemon was launched and how the task is keyed). The
      // latter is otherwise indistinguishable and the usual silent culprit, so
      // name the slug we wanted and the slugs the daemon actually serves.
      const text = daemonConnected()
        ? `error running assistant: a daemon is connected but does not serve this project (slug '${project.slug}'); daemon serves: ${daemonSlugs().join(', ') || '(none)'}`
        : 'error running assistant: no daemon connected for this project'
      recordAssistantError(t, text, at)
      // The turn never reached the agent, so nothing was committed — wedge and
      // stash the prompt(s) so the user can just retry once a daemon is back (a
      // transient daemon outage is the expected cause). The retry ask names the
      // cause rather than reading as a generic assistant error.
      wedgeForRetry(t, {
        committed: false,
        askId: nextAskId(t, Date.parse(at)),
        at,
        prompt: daemonConnected()
          ? 'The connected daemon does not serve this project.'
          : 'No daemon is connected to run this task.',
      })
      t.updatedAt = at
    }).catch(() => {})
    return 'crashed'
  }

  // Refuse to dispatch a flow the current primary hasn't announced. A legacy
  // flow is exempt: it carries `agent`, so even a daemon that announces nothing
  // (an old one, or one rolled back below this field) can drive it.
  //
  // Checked AFTER awaitDaemonServing, so a reconnect blip can't wedge a task
  // that a moment later would have been fine — by the time we are here a daemon
  // has registered, and setAnnouncedFlows runs before the slug set that released
  // us. Failing here is a wedge with a named cause, never a silent run as some
  // other flow.
  if (!isAgentKind(flow) && !isAnnouncedFlow(flow)) {
    await mutateTask(file, (t) => {
      const at = new Date().toISOString()
      const text =
        `error running assistant: no connected daemon provides the flow '${flow}'` +
        `; available: ${flowRegistry(project.slug).map((f) => f.name).join(', ') || '(none)'}`
      recordAssistantError(t, text, at)
      wedgeForRetry(t, {
        committed: false,
        askId: nextAskId(t, Date.parse(at)),
        at,
        prompt: `The connected daemon does not provide the '${flow}' flow.`,
      })
      t.updatedAt = at
    }).catch(() => {})
    return 'crashed'
  }

  // Mark riding and record the run before sending, so a crash between here and the
  // first update still leaves a resumable pointer (recoverQueues reattaches via
  // the persisted runId/runCursor). Don't bump updatedAt: the riding flip isn't a
  // turn boundary, and the triggering user message already set it.
  await mutateTask(file, (t) => {
    t.status = 'riding'
    if (!t.token) t.token = token
    t.runId = runId
    t.runCursor = 0
    // Open the ride for this run (id = runId), now that it's being handed to the
    // daemon. closeRide stamps its outcome when the run finishes; a crash/abandon
    // closes it interrupted (see reduceRunWs / driveTask).
    startRide(t, runId, new Date().toISOString())
    // A new turn supersedes any pending retry from the last failed one.
    delete t.retry
  })

  const start: StartRunMessage = {
    type: 'start-run',
    runId,
    taskId: id,
    // Both, deliberately: `flow` is what the daemon reads, `agent` is the
    // legacy-only fallback for a daemon that predates it (undefined otherwise).
    ...(agent ? { agent } : {}),
    flow,
    ...(task.flowConfig !== undefined ? { flowConfig: task.flowConfig } : {}),
    project: project.slug,
    // cwd hints — the daemon does the stat/fallback/worktree resolution locally.
    recordedCwd: task.cwd,
    // Present only on the turn an incoming message revived, so the daemon can
    // tell the resumed session which of its own last acts no longer holds — the
    // wedge/land it called, or the rest wakeup the message cleared.
    ...(revived ? { revived } : {}),
    prompt,
    task: {
      allowEdits: task.allowEdits,
      allow: task.allow,
      worktree: task.worktree,
    },
    // The provider session to resume; absent on the first turn, so the daemon
    // reports one back (reduceRunWs persists it onto the task's thread state).
    sessionId: taskSessionId(task),
    // The context baseline rides only with a session to resume: a fresh session
    // (first turn, or post-relaunch) must always receive the full block.
    turnContext: taskSessionId(task) ? taskTurnContext(task) : undefined,
    // The flow's durable state rides in on start-run so ctx.state.get is a free
    // read, and its revision rides with it so the flow's state-patch producer
    // seeds its counter above applyStatePatch's dedupe guard — without that seed
    // every ride after the first would have its writes silently dropped. Both are
    // additive: the compiled adapters ignore them.
    flowState: task.flowState,
    flowStateRev: task.flowStateRev,
    // This turn's attachment refs; the daemon materializes them and builds the
    // prompt manifest. Omitted when the turn carries none.
    attachments: attachments.length ? attachments : undefined,
    env: landerEnv,
    // The idle watchdog window, sent on every run (this is the OPERATIVE idle
    // value — daemon/run.ts DEFAULT_IDLE_MS is only a fallback for when this is
    // omitted, which it never is). Deliberately set ABOVE the Claude CLI's hard
    // ~600s (10 min) foreground-Bash cap so that when a quiet long-running
    // foreground command hits 600s and the CLI auto-moves it to the background —
    // returning control to the agent and emitting a stream event — that always
    // beats this watchdog. Before this the window sat AT 600s, tying the cap and
    // wedging the ride when the watchdog won the race by ~50ms (easel
    // PcnoAnNEyG, 4/4). 15 min = the 600s cap + a comfortable margin; polling of
    // a backgrounded task resets the window, so this only needs to exceed the
    // single largest SILENT gap (the 600s cap), not the total command duration.
    // (BASH_MAX_TIMEOUT_MS does NOT raise the 600s cap — verified — so there is no
    // "pin" to align to; see daemon/claude.ts.) Trade-off: a genuine silent hang
    // now takes 15 min to detect, up from 10. FLAGGED FOR REVIEW.
    idleTimeoutMs: 15 * 60_000,
  }
  sendToDaemon(start)
  return reduceRunWs(project, id, runId)
}

// The transcript line and retry-ask prompt for a platform kill: the daemon that
// held an in-flight run died and stayed gone past the reconnect grace, so it never
// settled its own done (unlike a user interrupt, which emits a clean interrupted
// done). The `crashed` handler names the cause here so the wedge reads as a
// platform kill to retry, not a silent interrupt or a generic assistant error.
// The prompt states what happened rather than asking ("— retry?"): the options
// below it are the question, and the prompt outlives them as the conversation's
// record of the kill once the ask is answered or withdrawn.
const PLATFORM_KILL_ERROR =
  'error running assistant: the daemon running this task stopped before the turn finished'
const PLATFORM_KILL_PROMPT =
  'This ride was killed by a daemon update while work was in flight.'

// Drain the per-run channel the WS handler feeds (update/done/crashed) and fold
// each event onto the task with the applyUpdate/applyDone consumer. The daemon
// did the reduction and the cross-line usage accumulation, so an `update` maps
// straight onto applyUpdate (seq becomes the run cursor); `done` finalizes;
// `crashed` (the daemon stayed gone past the reconnect grace) wedges the task
// with a platform-kill retry ask. Returns 'done' on completion (success or
// assistant error) or 'crashed'. `resume` reattaches to a run already in flight (a server
// reload, or queue recovery): it seeds the cursor from disk and asks a connected
// daemon to replay from there — the daemon either replays its buffer or aborts a
// run it no longer holds.
async function reduceRunWs(
  project: Project,
  id: string,
  runId: string,
  { resume = false }: { resume?: boolean } = {},
): Promise<'done' | 'crashed'> {
  const file = path.join(project.dataDir, `${id}.json`)
  const channel = openRunChannel(runId)
  // The reset time from a rejecting rate_limit_event, carried onto applyDone's
  // retry. The daemon resends the sticky value on each update; we keep the latest.
  let rateLimitResetsAt: string | undefined
  // Only apply a seq past the last one we folded in — guards against a replayed
  // update from a resume-from. Seeded from the task's persisted run cursor so a
  // reattach resumes from exactly what's on disk; the channel mirrors it so the
  // connection manager knows where to tell the daemon to replay from.
  const seed = resume ? await readTask(project.dataDir, id) : null
  let lastSeq = seed?.runCursor ?? -1
  channel.lastSeq = lastSeq
  // If a daemon is already connected when we reattach, ask it to replay now (the
  // race where the channel opens after the daemon connected); if it connects
  // later, the connection handler resumes us. Both are seq-deduped below.
  if (resume) requestResume(runId)
  try {
    while (true) {
      const ev = await channel.next()
      if (ev.kind === 'crashed') {
        await mutateTask(file, (t) => {
          const at = new Date().toISOString()
          const ride = openRide(t)
          if (ride) {
            const rideItems = (t.items ?? []).filter((it) => it.rideId === ride.id)
            const streamedText = rideItems.some(
              (it) => it.kind === 'message' && it.text.trim().length > 0,
            )
            // Whether the turn had begun committing before the daemon vanished —
            // the same proxy applyDone uses to pick "try again" vs. re-send.
            const hadOutput =
              rideItems.some((it) => it.kind === 'tool') || streamedText
            // Only fill an otherwise-empty turn: the ask's prompt is the kill's
            // durable record (it outlives the form), so a turn that streamed
            // needs no synthetic line saying the same thing twice.
            if (!streamedText) recordAssistantError(t, PLATFORM_KILL_ERROR, at)
            // A platform kill — the daemon died mid-turn and never came back, so it
            // could not settle its own done — needs the user's attention just like
            // an assistant error. Wedge with a retry ask that names the cause.
            // Only override a still-riding task: a self-wedge/land the agent set
            // stands, exactly as applyDone guards.
            if (t.status === 'riding')
              wedgeForRetry(t, {
                committed: hadOutput,
                askId: nextAskId(t, Date.parse(at)),
                at,
                prompt: PLATFORM_KILL_PROMPT,
              })
            t.updatedAt = at
          }
          // The run was abandoned (the daemon stayed gone past the grace) — close
          // its open ride as an error (a platform kill, not a user interrupt),
          // paired with the runId delete below.
          //
          // The fire is recorded from the ride captured above, and only if there
          // was one: `closeRide` no-ops without an open ride, so an unguarded
          // record here would emit a fire naming a ride that some other path
          // closed for another reason at another time — which a supervision body
          // would then try to cut a segment from.
          recordRideEnded(t, ride, 'error', at)
          closeRide(t, 'error', at)
          delete t.runId
          delete t.runCursor
        }).catch(() => {})
        return 'crashed'
      }
      if (ev.kind === 'session') {
        // The daemon reported (or re-announced) this task's provider session id.
        // Persist it once so every later turn resumes the same session. Idempotent:
        // a replayed announcement after a reconnect finds it already set.
        await mutateTask(file, (t) => {
          if (!taskSessionId(t)) setTaskSessionId(t, ev.msg.sessionId)
        }).catch(() => {})
        continue
      }
      if (ev.kind === 'turn-context') {
        // The daemon appended a fresh dynamic context block to this turn's
        // prompt; record it as the baseline the next turn's block is compared
        // against. Idempotent: a resume-from replay re-sends the same block.
        await mutateTask(file, (t) => {
          setTaskTurnContext(t, ev.msg.context)
        }).catch(() => {})
        continue
      }
      if (ev.kind === 'state-patch') {
        // Fold the flow's durable-state batch onto task.flowState inside the
        // serialized task mutation; the rev guard makes a replay idempotent.
        // Mirrors the session/turn-context handling above. No producer emits this
        // in step 1, so this branch is inert until the flow port (step 3).
        // step 3: buffer + replay on resume-from once a producer exists (the
        // daemon must re-send state-patches like session/turn-context; the rev
        // guard here provides the dedupe).
        await mutateTask(file, (t) => {
          applyStatePatch(t, ev.msg.ops, ev.msg.rev)
        }).catch(() => {})
        continue
      }
      if (ev.kind === 'update') {
        const u = ev.msg
        if (u.seq <= lastSeq) continue
        lastSeq = u.seq
        channel.lastSeq = u.seq
        // The daemon owns usage refresh (it has its own rate-limit trigger); we
        // only keep the reset time to carry onto applyDone's retry stash.
        if (u.rateLimitResetsAt) rateLimitResetsAt = u.rateLimitResetsAt
        await mutateTask(file, (t) => {
          applyUpdate(t, {
            steps: u.steps,
            finalText: u.finalText,
            blockedIds: u.blockedIds ?? [],
            usage: u.usage,
            usageChanged: u.usageChanged,
            drivingModel: u.drivingModel,
            cursor: u.seq,
          })
        }).catch(() => {})
      }
      if (ev.kind === 'done') {
        const at = new Date().toISOString()
        await mutateTask(file, (t) => {
          applyDone(t, ev.msg, {
            rateLimitResetsAt,
            at,
            askId: nextAskId(t, Date.parse(at)),
          })
        }).catch(() => {})
        // Tell the daemon it can drop this run's replay buffer.
        sendToDaemon({ type: 'ack', runId })
        return 'done'
      }
    }
  } finally {
    closeRunChannel(runId)
  }
}

// Tasks with an agent run (and its queue drain) in flight, keyed by task id.
// Guards against spawning a second concurrent process on the same session: a
// follow-up that arrives while this is set is appended to the task's `queued`
// array and picked up by the active drainer instead.
const running = new Set<string>()

// Drive a task's turns to completion: run the given opening turn, then drain
// any messages queued onto the task while it ran — the whole queue joins into
// one turn (see the batch note below) — until the queue empties. Only one
// drainer runs per task at a time. We come to rest at "resting" once the queue
// is empty, unless the agent set its own status mid-run (e.g. `lander wedge` to
// ask for input, or `lander land`), which we must not clobber.
async function driveTask(project: Project, id: string): Promise<void> {
  if (running.has(id)) return
  running.add(id)
  const file = path.join(project.dataDir, `${id}.json`)
  try {
    // Reattach first: if a previous turn's run is still tracked (its runner
    // outlived a server restart, or finished while we were down), finish
    // reducing it before starting anything queued. Whether each turn starts a
    // fresh session or resumes is the daemon's call from task.sessionId, so
    // nothing here needs to track it.
    const existing = await readTask(project.dataDir, id)
    if (existing?.runId) {
      await reduceRunWs(project, id, existing.runId, { resume: true })
    }
    // Retry a name that failed to generate at creation (or on a prior wakeup).
    // Every wakeup flows through here — a user follow-up and a scheduled/awaited
    // launch alike — so this is where a transient naming failure gets another
    // shot, named (as the first attempt would have been) from the opening
    // message. Fire-and-forget so it never holds up the turn; ensureTitle no-ops
    // once the user has named the task themselves.
    if (existing?.titlePending) {
      const opening = userItems(existing)[0]?.text
      if (opening) void ensureTitle(project, id, opening).catch(() => {})
    }
    while (true) {
      // Drain the whole queue at once, not one prompt per turn: several
      // follow-ups that piled up while the previous turn ran are sent together
      // as a single turn (joined into one prompt) rather than one turn each.
      // They stay distinct user messages on the task — only the turn count
      // collapses — so the UI still shows them as separate messages under one
      // reply. The loop repeats because more can arrive while this batch runs;
      // those become the next batched turn.
      // Mint the run id here, at queue-drain time, so the ride id is in hand to
      // stamp the batch's user items with `deliveredIn` (making the batching
      // visible). runTurn opens the ride under this id when it hands off the run.
      const runId = randomUUID()
      let batch: string[] = []
      let atts: Attachment[] = []
      let revived: RevivedMarker | undefined
      await mutateTask(file, (t) => {
        // Take the one-shot revival marker with the batch, under the same lock
        // that drains it: it then rides with exactly the turn the reviving
        // message produced and cannot leak into the next one. Cleared even when
        // the drain finds nothing to send — a marker with no turn left to ride
        // is stale, not pending.
        revived = t.revived
        delete t.revived
        if (t.queued && t.queued.length) {
          batch = t.queued
          // Gather the attachments off the trailing user items this batch is made
          // of, under the same lock, so the run carries exactly this turn's files.
          atts = turnAttachments(t, batch.length)
          // Stamp deliveredIn on this batch's user items and move the freshly-
          // delivered ones to the tail so array order becomes delivery order — a
          // mid-ride follow-up otherwise renders before the reply it was delivered
          // after (buildTimeline trusts array order). See deliverQueuedBatch.
          deliverQueuedBatch(t, batch.length, runId)
          delete t.queued
        }
      }).catch(() => {})
      if (!batch.length) break
      await runTurn(project, id, batch.join('\n\n'), runId, atts, revived)
    }
  } finally {
    running.delete(id)
    // Under the status collapse there's no riding→resting demotion to do — a
    // closed ride *is* the demotion (publicTask serves `resting` when no ride is
    // open). We only tidy a stray open ride: if no run is tracked yet one is still
    // open (a run abandoned without a paired close), stamp it interrupted so it
    // doesn't linger as a live ride. A runId here belongs to a *newer* drainer
    // that re-rode after we left the running set, so leave its ride alone.
    await mutateTask(file, (t) => {
      if (!t.runId) closeRide(t, 'interrupted', new Date().toISOString())
    }).catch(() => {})
  }

  // A follow-up can land after our final drain read but before we left the
  // running set, with the sender seeing us as still active and so not starting
  // its own drainer. Re-check once and pick it back up if so.
  let leftover = false
  await mutateTask(file, (t) => {
    leftover = !!(t.queued && t.queued.length)
  }).catch(() => {})
  if (leftover) void driveTask(project, id)
}

// Launch a deferred (scheduled) task now: clear its scheduledFor, record the
// "launched" event, mark it riding, and drive its queued opening message.
// Drives "start" if it never established a session, "resume" otherwise. A no-op
// (returns false) if the task isn't actually scheduled or is already running —
// so the scheduler sweep and a manual launch racing on the same task can't
// double-launch it or push two "launched" events.
// `by` names who launched it, for the hook a resulting un-wedge would fire: the
// scheduler when the sweep reaches a due task, the human when they press Launch.
// Parameterized rather than assumed `system` because both callers are real, and
// the UI's button is the one a `wedged/human/` hook would care about.
async function launchTask(
  project: Project,
  id: string,
  by: string,
): Promise<boolean> {
  const file = path.join(project.dataDir, `${id}.json`)
  let go = false
  let everRan = false
  await mutateTask(file, (t) => {
    // Launch on either pending trigger (a scheduled time or an await condition);
    // the scheduler only calls us once one has fired. Clear both so the OR
    // fallback doesn't re-fire the task after it's running.
    if ((!t.scheduledFor && !t.waitingFor) || running.has(id)) return
    // "Ever ran" = has driven at least one ride (established a session), so a
    // rested task gets the synthetic resume prompt while a deferred new task drives
    // its still-queued opening message instead.
    everRan = (t.rides?.length ?? 0) > 0
    delete t.scheduledFor
    delete t.waitingFor
    const at = new Date().toISOString()
    // A task that scheduled a session-limit retry stayed wedged until now (see
    // the /retry handler), so record the un-wedge a hair ahead of the launch —
    // it surfaces in the timeline before the queued recovery prompt that the
    // wakeup is about to drive. A no-op for a merely-resting scheduled task.
    recordStatusTransition(
      t,
      'riding',
      new Date(Date.parse(at) - 1).toISOString(),
      by,
    )
    pushEventItem(t, { eventKind: 'launched', title: t.title }, at)
    t.status = 'riding'
    t.updatedAt = at
    // A task put to rest with `lander rest` has already run its opening turn, so
    // nothing is queued to wake it — give the agent a prompt announcing it's
    // back. A task scheduled at creation (`new --date`) still has its opening
    // message queued and drives that instead, so skip the synthetic prompt.
    if (everRan && !(t.queued && t.queued.length)) {
      const text = `Resumed at ${new Date(at).toLocaleString()}.`
      pushUserItem(t, text, at)
      ;(t.queued ??= []).push(text)
    }
    go = true
  }).catch(() => {})
  if (go) void driveTask(project, id)
  return go
}

// Deliver a task's now-due scheduled messages (from `lander send --date/--wait`):
// append each as a user message, queue it, and drive the task — the same path an
// immediate send takes. Not-yet-due messages stay put. Skipped while the task is
// itself awaiting a future scheduled launch, so a queued message can't wake a
// deferred task ahead of its time; it'll be delivered once the task launches.
async function deliverScheduledMessages(
  project: Project,
  id: string,
  now: number,
): Promise<void> {
  const file = path.join(project.dataDir, `${id}.json`)
  // A message fires on its time and/or its await condition, whichever comes
  // first. Reading the awaited tasks' statuses is async, so resolve them up
  // front into a map and let the in-mutation due-check stay synchronous; a
  // missing awaited task counts as landed (it can no longer land).
  const seed = await readTask(project.dataDir, id)
  const landed = new Map<string, boolean>()
  for (const m of seed?.scheduledMessages ?? [])
    for (const w of m.waitFor ?? [])
      if (!landed.has(w)) {
        const t = await readTask(project.dataDir, w)
        landed.set(w, !t || t.status === 'landed')
      }
  const isDue = (m: { deliverAt?: string; waitFor?: string[] }) =>
    (m.deliverAt != null && Date.parse(m.deliverAt) <= now) ||
    ((m.waitFor?.length ?? 0) > 0 && m.waitFor!.every((w) => landed.get(w)))

  let drive = false
  await mutateTask(file, (t) => {
    // Hold delivery while the recipient hasn't launched yet — it's itself
    // awaiting a future time or an await condition; the message waits for it.
    if (t.scheduledFor && Date.parse(t.scheduledFor) > now) return
    if (t.waitingFor?.length) return
    const pending = t.scheduledMessages ?? []
    const due = pending.filter(isDue)
    if (!due.length) return
    const rest = pending.filter((m) => !isDue(m))
    if (rest.length) t.scheduledMessages = rest
    else delete t.scheduledMessages
    const at = new Date().toISOString()
    // Delivery revives a wedged/landed recipient, same as a live send; record
    // the transition a hair ahead of the messages so the timeline orders right.
    //
    // `system`, and this is a known gap rather than a choice: delivery happens
    // on the scheduler, long after the sender is gone, so a human's `lander send
    // --date` arrives here indistinguishable from a timer. A hook under
    // `unwedged/human/` will not see it. Fixing it means recording the
    // originator on the ScheduledMessage at send time.
    recordStatusTransition(
      t,
      'riding',
      new Date(Date.parse(at) - 1).toISOString(),
      'system',
    )
    // Append (and queue) the due messages. If any is a relaunch, applyDueMessages
    // seals the session and records the divider before appending, so the
    // delivering turn mints a fresh assistant session — the deferred analog of
    // the immediate /relaunch endpoint.
    applyDueMessages(t, due, at)
    t.status = 'riding'
    t.updatedAt = at
    drive = true
  }).catch(() => {})
  // Mirror the /messages endpoint: a run already in flight drains the queue when
  // it finishes; otherwise start a drainer now.
  if (drive && !running.has(id)) void driveTask(project, id)
}

// Scan every project for scheduled tasks whose launch time has arrived and run
// them, and deliver any due scheduled messages. Best-effort: a periodic sweep
// (and one on boot) acts as soon as each is due, or right away if its time
// already passed while the server was down. launchTask guards against launching
// one twice.
// Set while a sweep is in flight. The sweep is `setInterval`-driven with no
// coupling to its own completion, so a slow pass already overlapped the next one
// — and this increment puts more work beneath it.
//
// Cleared in a `finally`, and that is not decoration: the sweep has no internal
// try/catch around `awaitSatisfied`/`launchTask`, so a latched flag would kill
// scheduled-message delivery, deferred launches and every `lander rest` wakeup
// for the whole instance until a restart. The guard is against a HANG; a
// rejection needs no guard, since with no `unhandledRejection` handler the
// process dies and `tsx watch` brings it back.
let sweeping = false
let sweepStartedAt = 0
// Past this, a sweep is assumed wedged rather than slow and the guard is
// released. Without it the guard can become the outage it prevents: the
// `finally` only runs when the promise settles, so a sweep hung on a wedged
// `awaitSatisfied` or an unresponsive filesystem would latch the flag and stop
// scheduled-message delivery, deferred launches and every `lander rest` wakeup
// instance-wide until a restart. Before the guard existed a hung sweep only
// delayed itself.
const SWEEP_STUCK_MS = 5 * 60_000

// How many tasks per project may have their fires dispatched in one sweep. A
// rate limit, paired with the instance-wide ceiling on concurrent hook hosts in
// hook-runs.ts — this one keeps a backlog from being fired off all at once, that
// one keeps the daemon from holding forty Node processes at a time.
//
// Per project rather than global: the sweep walks PROJECTS in order and readdir
// in order, so a single global budget would be consumed by the same early tasks
// in the same early project every pass, and later projects would never dispatch
// at all — silently, since a hold records nothing.
const MAX_HOOK_DISPATCHES_PER_SWEEP = 4

async function launchScheduled(): Promise<void> {
  if (sweeping) {
    if (Date.now() - sweepStartedAt < SWEEP_STUCK_MS) return
    console.warn(
      `scheduler sweep has been running for ${Math.round(
        (Date.now() - sweepStartedAt) / 1000,
      )}s; starting another rather than stalling every wakeup`,
    )
  }
  sweeping = true
  sweepStartedAt = Date.now()
  try {
    await sweepOnce()
  } finally {
    sweeping = false
  }
}

async function sweepOnce(): Promise<void> {
  const now = Date.now()
  const api =
    process.env.LANDER_PUBLIC_API?.trim() || `http://localhost:${port}`
  for (const project of PROJECTS) {
    let names: string[]
    try {
      names = await readdir(project.dataDir)
    } catch {
      continue
    }
    let dispatched = 0
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      let task: Task
      try {
        task = JSON.parse(
          await readFile(path.join(project.dataDir, name), 'utf8'),
        ) as Task
      } catch {
        continue
      }
      // Deliver due scheduled messages first — independent of the task's own
      // scheduled launch, and even while it's running (delivery just enqueues).
      // Let deliverScheduledMessages decide due-ness (it weighs time and await
      // triggers); just gate on there being anything pending.
      if (task.scheduledMessages?.length)
        await deliverScheduledMessages(project, id, now)
      // Dispatch this task's recorded fires. ABOVE the `running` guard below,
      // for the same reason scheduled-message delivery is: `running` holds every
      // task with a live driveTask, including one working through a chain of
      // queued turns, which is the common shape here. Below it, a busy task's
      // fires would sit until its whole chain ended and then age out — and the
      // symptom would be "hooks mostly work".
      //
      // Not awaited: a body may run for minutes, and the sweep also delivers
      // every project's scheduled messages. dispatchPendingHooks has its own
      // per-task guard and never rejects.
      // A task whose previous dispatch is still in flight consumes no budget:
      // otherwise four long-running bodies would spend the whole per-project
      // allowance on every sweep they span — a dozen or more — while every
      // other task in the project waited, silently, since a hold records
      // nothing.
      if (
        task.pendingHooks?.length &&
        !hookDispatchInFlightFor(project, id) &&
        dispatched < MAX_HOOK_DISPATCHES_PER_SWEEP
      ) {
        dispatched++
        void dispatchPendingHooks(project, id, { api })
      }
      // Then launch a deferred task whose trigger has fired.
      if (running.has(id)) continue
      const timeDue =
        task.scheduledFor != null && Date.parse(task.scheduledFor) <= now
      const awaitDue =
        (task.waitingFor?.length ?? 0) > 0 &&
        (await awaitSatisfied(project, task.waitingFor!))
      if (timeDue || awaitDue) await launchTask(project, id, 'system')
    }
  }
}

// The latest telemetry snapshot each flow pushed, keyed by FLOW NAME (decision
// 6). A producing flow owns the fetch + refresh schedule and sends a `telemetry`
// message on each refresh, which lands here via the WS handler; the server only
// caches the items and serves them (the tasks poll embeds them, /api/telemetry
// returns them). The server never learns what the items mean, nor reads any
// credential — which is what lets it move into a credential-less container later.
//
// Keyed by name rather than AgentKind because an adapter-less flow has no agent
// kind; the wire already reads `msg.flow ?? msg.agent`, and the client has always
// consumed this as a plain Record<string, …>.
const telemetryCache = new Map<string, TelemetryItem[]>()

// The shared secret that marks a request as coming from the human's browser
// (vs. a task's `lander` CLI). Prefer the env var dev.mjs sets — it hands the
// same value to Vite so the client can send it — and fall back to a persisted
// file so a manual API restart keeps the value the running browser already
// holds. Generated on first use.
//
// Tasks don't get this in their env — but only because two things keep it out:
// dev.mjs hands it to this process alone rather than to the environment all
// three processes inherit, and the daemon deletes its own copy once it has read
// it (server/secrets.ts). Both were absent until recently, and the value did
// reach every task's shell, where presenting it here resolves as `ui`.
//
// It is not out of a task's reach, and nothing here can put it there: a fully
// adversarial task on the same machine can read the file, fetch it from the Vite
// dev server, or read another process's exec-time environment. That is inherent
// to running untrusted agents as the same user. What the two measures above buy
// is that it no longer arrives by default, in every shell, for free.
async function loadUiToken(): Promise<string> {
  const fromEnv = process.env.LANDER_UI_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const file = path.join(DATA_ROOT, '.ui-token')
  try {
    const existing = (await readFile(file, 'utf8')).trim()
    if (existing) return existing
  } catch {
    // not yet created
  }
  const token = randomUUID()
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, token + '\n', { mode: 0o600 })
  return token
}

const UI_TOKEN = await loadUiToken()

// Who made a mutating request. `ui` is the trusted human browser (presented the
// UI token) and may grant any permission. `task` is an authenticated task (sent
// a matching X-Lander-Token for the id it claims) and may only pass on perms it
// holds itself. `anon` is an unidentified caller and may grant nothing.
type Principal =
  | { kind: 'ui' }
  | { kind: 'task'; task: Task; slug: string; id: string }
  | { kind: 'anon' }

async function resolvePrincipal(req: {
  header(name: string): string | undefined
}): Promise<Principal> {
  if (req.header('x-lander-ui-token') === UI_TOKEN) return { kind: 'ui' }
  const token = req.header('x-lander-token')
  const taskId = req.header('x-lander-task')
  const projectSlug = req.header('x-lander-project')
  if (token && taskId && projectSlug && TASK_ID.test(taskId)) {
    const project = PROJECT_BY_SLUG.get(projectSlug)
    const task = project && (await readTask(project.dataDir, taskId))
    // Constant value compare is fine here: the token is a random UUID, so a
    // timing side-channel doesn't meaningfully narrow the search space. The
    // header id is the task's id, carried on the principal so callers needn't
    // re-read the (legacy-named) field off the task.
    if (task && task.token && task.token === token)
      return { kind: 'task', task, slug: projectSlug, id: taskId }
  }
  return { kind: 'anon' }
}

// The principal a task hook selects on: a hook lives at
// `.lander/hooks/<trigger>/<by>/`, so this maps who made the request onto the
// directory level that names them. An open set of strings rather than a union —
// adding a principal later must not mean touching a mirrored type.
//
// `anon` becomes `system` deliberately: an unidentified caller is not a person,
// and a hook under `human/` must not fire for one. That is also why the browser
// now sends its token on every mutating call, gated or not — without it a human
// landing a task from the kebab arrives here as `anon`.
function hookBy(principal: Principal, taskId: string): string {
  if (principal.kind === 'ui') return 'human'
  if (principal.kind === 'task')
    return principal.id === taskId ? 'agent' : 'task'
  return 'system'
}

// Note that a human touched this task, which resets the runaway bound on the
// actions hooks are allowed to take against it. Every UI-principal route that
// touches a task calls this, not just `/messages`: a human who only ever answers
// a task's asks and un-wedges it from the kebab is contacting it just as
// unmanufacturably as one who types, and a bound that never reset would leave a
// hook permanently dead on that task while reporting "bound" — indistinguishable
// from a runaway it correctly stopped.
function noteHumanContact(
  task: { hookActionsResetAt?: string },
  principal: Principal,
  at: string,
): void {
  if (principal.kind === 'ui') task.hookActionsResetAt = at
}

export const app = new Hono()

// The per-flow status telemetry each producing adapter pushes, as an { agent:
// items } map — the same cache the tasks poll embeds. Opaque to the server; empty
// object until the first push lands. (The Claude flow publishes two usage meters
// here; other flows publish their own items or none.)
app.get('/api/telemetry', (c) =>
  c.json(Object.fromEntries(telemetryCache)),
)

// List the configured projects; the first is the default the UI redirects to.
app.get('/api/projects', (c) =>
  c.json(PROJECTS.map((p) => ({ path: p.path, slug: p.slug }))),
)

app.get('/api/:project/tasks', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    // By default only active tasks are listed; `?archived=1` lists only the
    // archived ones instead, each tagged so the UI can mark the row and offer
    // Restore.
    // Flow status telemetry rides along with every tasks poll so the client never
    // has to decide when it's stale (the producing adapter refreshes and pushes it
    // — decision 6). It's global, not per-project — the same { agent: items } map
    // on every project's response.
    const telemetry = Object.fromEntries(telemetryCache)
    // `?view=summary` serves each task without its conversation (see
    // taskSummary). Opt-in: with no param the response is what it always was,
    // so the running client and any third-party caller are unaffected. Applied
    // as a projection *inside* both branches below rather than as a third
    // branch beside them, so the telemetry envelope can't be dropped from it.
    const summary = c.req.query('view') === 'summary'
    const toWire = <T extends object>(t: T) =>
      summary ? taskSummary(t) : publicTask(t)
    if (c.req.query('archived') !== '1')
      return c.json({
        // Arrow-wrapped: a bare `.map(publicTask)` binds the array index to the
        // options parameter.
        tasks: (await readTasks(project.dataDir)).map((t) => toWire(t)),
        telemetry,
      })
    const archived = (await readTasks(project.archiveDir)).map((t) => ({
      ...t,
      archived: true,
    }))
    archived.sort((a, b) =>
      (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
    )
    return c.json({ tasks: archived.map((t) => toWire(t)), telemetry })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// A single task by id (for `lander view`). Same public shape as the list.
app.get('/api/:project/tasks/:id', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  const id = c.req.param('id')
  if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
  const task = await readTask(project.dataDir, id)
  if (task) return c.json(publicTask(task))
  // Fall back to the archive so `lander view` can read a task after it's been
  // archived — the id resolves against both pools, so the view endpoint must too.
  // Tagged `archived` (like the list's `?archived=1` rows) so the caller can mark it.
  const archived = await readTask(project.archiveDir, id)
  if (archived) return c.json(publicTask({ ...archived, archived: true }))
  return c.json({ error: 'task not found' }, 404)
})

// The driver flows this project can launch a task with, as the new-task picker
// renders them. Sourced from the registry, which is the announced set unioned
// with the frozen legacy entries — so everything served here is either something
// the primary daemon said it can run, or claude/codex (which dispatch carries
// `agent` for). Nothing offered here can be picked and then wedge on first
// message.
//
// A SIBLING of the /flows/:name resolver below, not a replacement: that one
// serves the unrelated user command-flow scripts for the `lander flow` CLI. The
// two notions of "flow" converge in step 6; the different segment count keeps
// them from colliding until then.
app.get('/api/:project/flows', (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  return c.json({ flows: flowRegistry(project.slug) })
})

// A trigger or principal, as the directory level naming it. An open set — adding
// a principal must not mean editing a union here — so this validates the shape of
// a directory name rather than enumerating the values.
const HOOK_SEGMENT = /^[\w][\w.-]{0,63}$/

// What this project's tree declares under `.lander/hooks/`, and what each
// declared version's approval state is. The daemon answers the git half (the
// server has no repository access); the store answers the approval half.
//
// `?trigger=` and `?by=` narrow it to what one transition would select — `by`
// implying `any` alongside it, as dispatch does. `?task=` resolves against that
// task's own checkout, which is the tree whose hooks would actually run for it;
// without it the project root answers.
//
// Identified callers only. It exposes no file content — paths, blobs and states —
// but it does describe the project's tree, and an anon caller has no business
// with it.
app.get('/api/:project/hooks', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  const principal = await resolvePrincipal(c.req)
  if (principal.kind === 'anon') return c.json({ error: 'not authorized' }, 403)

  const trigger = c.req.query('trigger')
  const by = c.req.query('by')
  for (const [name, value] of [
    ['trigger', trigger],
    ['by', by],
  ] as const)
    if (value !== undefined && !HOOK_SEGMENT.test(value))
      return c.json({ error: `invalid ${name}` }, 400)
  const select: HookSelector[] | undefined =
    trigger && by
      ? selectorsFor(trigger, by)
      : trigger
        ? [{ trigger }]
        : by
          ? [{ by }]
          : undefined

  let checkout: Awaited<ReturnType<typeof taskCheckout>> = {}
  const taskId = c.req.query('task')
  if (taskId) {
    if (!TASK_ID.test(taskId)) return c.json({ error: 'invalid task id' }, 400)
    checkout = await taskCheckout(project, taskId)
    if (!checkout) return c.json({ error: 'task not found' }, 404)
  }

  const result = await resolveProjectHooks({
    project,
    ...(select ? { select } : {}),
    ...checkout,
  })
  if (!result.ok)
    return c.json(
      { error: result.error },
      result.status as ContentfulStatusCode,
    )
  return c.json(result.hooks)
})

// A hook module's path, as the tree carries it. Validated on the way into the
// store because the store is keyed by it — never used to open a file here, since
// the server reads no repository.
//
// It must accept exactly what the daemon's parseHookPath enumerates, or a hook
// this endpoint has just listed as pending would fail to approve with no way
// forward. Written as the same segment walk rather than as a regex mirroring it:
// the two live on opposite sides of the WebSocket and cannot share code, so the
// closer they read the likelier they stay in step. (A regex here had a real bug —
// `(?!\.\.?$)` anchors at the end of the STRING, so it rejected a trailing `..`
// and admitted `.lander/hooks/../../evil.js`.)
function isHookPath(p: string): boolean {
  if (p.includes('\n')) return false
  const parts = p.split('/')
  if (parts.length !== 5) return false
  const [dot, hooks, trigger, by, file] = parts
  if (dot !== '.lander' || hooks !== 'hooks' || !file.endsWith('.js')) return false
  const name = file.slice(0, -'.js'.length)
  return [trigger, by, name].every((s) => s !== '' && s !== '.' && s !== '..')
}
// A whole object name. Git's short forms are unambiguous to git and useless
// here: the store is a set of exact strings, so a prefix is an entry that can
// never match the pair it was meant to approve.
const BLOB_ID = /^([0-9a-f]{40}|[0-9a-f]{64})$/

// Read the (path, blob) pair a content-approval request names.
async function hookPairFromBody(req: {
  json<T>(): Promise<T>
}): Promise<{ pair?: { path: string; blob: string }; error?: string }> {
  const body = await req.json<{ path?: unknown; blob?: unknown }>()
  const p = typeof body.path === 'string' ? body.path : ''
  const blob = typeof body.blob === 'string' ? body.blob : ''
  if (!isHookPath(p)) return { error: 'invalid hook path' }
  if (!BLOB_ID.test(blob)) return { error: 'invalid blob id' }
  return { pair: { path: p, blob } }
}

// Approve one version of one hook. The pair, not the blob: with the trigger in
// the path, the same content at a different path fires at a different time.
//
// Human-only, like granting a tool rule and for a stronger reason — an approved
// hook runs unattended, with daemon privileges, so this is approving an entry
// point rather than a behavior. A task must not be able to approve its own.
app.post('/api/:project/hooks/approve', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  if ((await resolvePrincipal(c.req)).kind !== 'ui')
    return c.json({ error: 'not authorized to approve hooks' }, 403)
  const { pair, error } = await hookPairFromBody(c.req)
  if (!pair) return c.json({ error }, 400)
  await approveHookPairs(project.hooksFile, [pair], 'content', {
    at: new Date().toISOString(),
  })
  return c.json({ ok: true })
})

// The last gate before a hook body is imported: the host asks whether the pair
// it was dispatched with is approved *now*, and refuses to materialize if not.
//
// Approval gates materialization, not only dispatch. A dispatch and its run are
// separated by a process spawn and a `git cat-file`, and a human revoking an
// approval in that window must be obeyed — otherwise "revoke" means "stop the
// next one", which is not what the button says.
//
// Answered by the server rather than the daemon because the approval store is
// the server's and the daemon holds no approval knowledge — the split increment
// A established. Three distinct answers, and the distinction between the first
// two matters: `credential-unknown` means this server restarted and no longer
// holds the token (it happens on every `server/**` edit, and must not burn a
// retry attempt or read as a revocation), while `not-approved` is the real T7
// case.
app.post('/api/:project/hooks/materialize', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  const cred = readHookCredential(c.req.header('x-lander-hook-token'))
  if (!cred || cred.project !== project.slug)
    return c.json(
      { error: 'unknown or expired hook credential', reason: 'credential-unknown' },
      401,
    )
  const body = await c.req.json<{ fireId?: unknown; path?: unknown; blob?: unknown }>()
  // The host may only ask about what it was dispatched with. A mismatch is a bug
  // or an attempt to widen the credential; either way it is not approved.
  if (
    body.fireId !== cred.fireId ||
    body.path !== cred.path ||
    body.blob !== cred.blob
  )
    return c.json(
      { error: 'credential does not cover this hook version', reason: 'mismatch' },
      403,
    )
  const store = await readHooksStore(project.hooksFile)
  const approvals = effectiveApprovals(store)
  if (!approvals.has(pairKey({ path: cred.path, blob: cred.blob })))
    return c.json(
      { error: 'this hook version is not approved', reason: 'not-approved' },
      403,
    )
  return c.json({ ok: true })
})

// Withdraw a content approval. A version that is also on the trust root keeps
// running: that approval came from the branch, and the way to withdraw it is to
// stop trusting the branch.
app.post('/api/:project/hooks/revoke', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  if ((await resolvePrincipal(c.req)).kind !== 'ui')
    return c.json({ error: 'not authorized to revoke hook approvals' }, 403)
  const { pair, error } = await hookPairFromBody(c.req)
  if (!pair) return c.json({ error }, 400)
  await revokeHookPairs(project.hooksFile, [pair])
  return c.json({ ok: true })
})

// Designate the branch whose hooks run without individual approval, or clear it
// (`ref: null`). A remote-tracking ref rather than a local branch: advancing one
// requires a push, so it passes whatever the remote enforces, where an agent that
// can merge could otherwise approve its own hook.
app.post('/api/:project/hooks/trust-root', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  if ((await resolvePrincipal(c.req)).kind !== 'ui')
    return c.json({ error: 'not authorized to set the trusted branch' }, 403)
  const body = await c.req.json<{ ref?: unknown }>()
  const raw = typeof body.ref === 'string' ? body.ref.trim() : ''
  if (body.ref !== null && typeof body.ref !== 'string')
    return c.json({ error: 'ref must be a string or null' }, 400)
  if (raw && !isSafeTrustRoot(raw))
    return c.json({ error: 'invalid branch name' }, 400)
  const store = await setTrustRoot(project.hooksFile, raw || null)
  return c.json({ ref: store.trustRoot ?? null })
})

// Flow names are bare filenames (<name>.js under the project's flows dir), so
// reject anything with path separators or dots that could traverse out of it.
const FLOW_NAME = /^[\w-]+$/

// Resolve a flow script's path for the `lander flow` CLI to import and run. The
// server only locates the file (keeping it the source of truth for where flows
// live); execution happens in the CLI, which shares this filesystem.
app.get('/api/:project/flows/:name', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  const name = c.req.param('name')
  if (!FLOW_NAME.test(name)) return c.json({ error: 'invalid flow name' }, 400)
  const file = path.join(project.flowsDir, `${name}.js`)
  try {
    await stat(file)
    return c.json({ path: file })
  } catch {
    return c.json({ error: `unknown flow: ${name}` }, 404)
  }
})

// Upload one or more file/image attachments to a project's durable blob store,
// returning their refs ({id,name,mime,size}). The browser (paperclip) and the
// `lander --files` CLI both POST here as multipart/form-data; each `file` part
// becomes one attachment. Only an identified caller may upload — the human
// (UI token) or an authenticated task — so an anon request can't fill the store.
// A follow-up POST /tasks or /messages carries the returned ids to associate them
// with a message. Over-size files 413; the whole request fails if any part does.
app.post('/api/:project/attachments', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  const principal = await resolvePrincipal(c.req)
  if (principal.kind === 'anon')
    return c.json({ error: 'not authorized to upload attachments' }, 403)
  try {
    const body = await c.req.parseBody({ all: true })
    // `all: true` yields a single value or an array per field; normalize the
    // `file` field to a flat list of the File parts the multipart body carried.
    const raw = body['file'] ?? body['files']
    const parts = (Array.isArray(raw) ? raw : [raw]).filter(
      (p): p is File => p instanceof File,
    )
    if (!parts.length) return c.json({ error: 'no files in upload' }, 400)
    const attachments: Attachment[] = []
    for (const part of parts) {
      const bytes = new Uint8Array(await part.arrayBuffer())
      attachments.push(
        await saveAttachment(project.attachmentsDir, {
          name: part.name,
          mime: part.type,
          bytes,
        }),
      )
    }
    return c.json({ attachments }, 201)
  } catch (e) {
    if (e instanceof AttachmentTooLargeError)
      return c.json(
        { error: `attachment too large (max ${MAX_ATTACHMENT_BYTES} bytes)` },
        413,
      )
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Stream an attachment's bytes from the durable store. Serves both the browser
// (thumbnails/downloads, UI token) and the daemon, which fetches here to
// materialize a task's files at turn time (authenticating with the task's
// LANDER_TOKEN). Only an identified caller may read; the store isn't scoped
// per-task, so any task in the project may fetch any of its attachments — fine
// under the same-project trust model.
app.get('/api/:project/attachments/:id', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  const principal = await resolvePrincipal(c.req)
  if (principal.kind === 'anon')
    return c.json({ error: 'not authorized' }, 403)
  const id = c.req.param('id')
  if (!isAttachmentId(id)) return c.json({ error: 'invalid attachment id' }, 400)
  const meta = await readAttachmentMeta(project.attachmentsDir, id)
  const bytes = meta && (await readAttachmentBytes(project.attachmentsDir, id))
  if (!meta || !bytes) return c.json({ error: 'attachment not found' }, 404)
  // Hand Hono a plain ArrayBuffer view of the blob (a Node Buffer isn't one of
  // c.body's accepted body types).
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  return c.body(ab, 200, {
    'content-type': meta.mime,
    'content-length': String(meta.size),
  })
})

// Publish an artifact — a named output file — of a task, latest version only.
// Multipart: a `file` part plus an optional `name` text field (defaults to the
// uploaded filename, sanitized then validated against the addressable-name
// regex). Publishing to an existing name mints a fresh blob, repoints the slot,
// and — only after the task JSON write commits — deletes the superseded blob (a
// crash strands an orphan, never a dangling ref). Only the human (UI token) or
// the task itself may publish; a task owns its own outputs. The buffered save
// (whole blob in memory) is acceptable for v1's local single-user server.
app.post('/api/:project/tasks/:id/artifacts', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)
    if (!(await readTask(project.dataDir, id)))
      return c.json({ error: 'task not found' }, 404)

    const principal = await resolvePrincipal(c.req)
    if (
      principal.kind !== 'ui' &&
      !(principal.kind === 'task' && principal.id === id)
    )
      return c.json(
        { error: 'only the task itself may publish its artifacts' },
        403,
      )

    const body = await c.req.parseBody()
    const part = body['file']
    if (!(part instanceof File)) return c.json({ error: 'no file in upload' }, 400)
    // Name defaults to the uploaded filename; sanitize (strip dirs/control chars)
    // then validate, so anything unsafe for a route segment / filename 400s here.
    const rawName =
      typeof body['name'] === 'string' && body['name'].trim()
        ? body['name']
        : part.name
    const name = sanitizeName(rawName)
    if (!isArtifactName(name))
      return c.json({ error: `invalid artifact name: ${name}` }, 400)

    const bytes = new Uint8Array(await part.arrayBuffer())
    let blob: Attachment
    try {
      blob = await saveAttachment(
        project.attachmentsDir,
        { name, mime: part.type, bytes },
        MAX_ARTIFACT_BYTES,
      )
    } catch (e) {
      if (e instanceof AttachmentTooLargeError)
        return c.json(
          { error: `artifact too large (max ${MAX_ARTIFACT_BYTES} bytes)` },
          413,
        )
      throw e
    }

    // Upsert the slot and record the message ref in one read-modify-write, then
    // delete the superseded blob after the write has committed.
    const now = new Date().toISOString()
    let artifact: Artifact | undefined
    let supersededId: string | null = null
    await mutateTask(file, (t) => {
      const res = upsertArtifact(t, { name, blob, at: now })
      artifact = res.artifact
      supersededId = res.supersededId
      recordArtifactOnMessage(t, res.artifact)
      t.updatedAt = now
    })
    if (supersededId) await deleteAttachment(project.attachmentsDir, supersededId)
    return c.json({ artifact }, 201)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// List a task's artifact slots (latest version of each). Any identified caller
// may read — the human or any task in the project — matching the attachment
// download's posture; an anon request is refused.
app.get('/api/:project/tasks/:id/artifacts', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  const id = c.req.param('id')
  if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
  const principal = await resolvePrincipal(c.req)
  if (principal.kind === 'anon') return c.json({ error: 'not authorized' }, 403)
  const task = await readTask(project.dataDir, id)
  if (!task) return c.json({ error: 'task not found' }, 404)
  return c.json({ artifacts: task.artifacts ?? [] })
})

// Stream an artifact's current blob by slot name, with its stored Content-Type
// and a filename download disposition (the name is regex-validated, so it's safe
// unquoted). Same read auth as the list/attachment download. 404 on an unknown
// task or name.
app.get('/api/:project/tasks/:id/artifacts/:name', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  const id = c.req.param('id')
  if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
  const principal = await resolvePrincipal(c.req)
  if (principal.kind === 'anon') return c.json({ error: 'not authorized' }, 403)
  const name = c.req.param('name')
  const task = await readTask(project.dataDir, id)
  if (!task) return c.json({ error: 'task not found' }, 404)
  const artifact = task.artifacts?.find((a) => a.name === name)
  if (!artifact) return c.json({ error: 'artifact not found' }, 404)
  const bytes = await readAttachmentBytes(project.attachmentsDir, artifact.id)
  if (!bytes) return c.json({ error: 'artifact not found' }, 404)
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  return c.body(ab, 200, {
    'content-type': artifact.mime,
    'content-length': String(artifact.size),
    'content-disposition': `attachment; filename="${artifact.name}"`,
  })
})

// Resolve a requested wakeup time from either `date` (any date/time the server
// can parse) or `wait` (minutes from now). The two are mutually exclusive. Used
// by task creation (`--date`/`--wait` on `lander new`) and by `lander rest`.
// Returns the ISO launch time, null when neither was given, or an error string
// for a bad/conflicting value — so a bad request fails loudly rather than
// silently creating something that never wakes.
function resolveSchedule(body: {
  date?: unknown
  time?: unknown
}): { scheduledFor: string | null } | { error: string } {
  const hasDate = typeof body.date === 'string' && body.date.trim() !== ''
  const hasTime = body.time !== undefined && body.time !== null
  if (hasDate && hasTime)
    return { error: '--date and --time are mutually exclusive' }
  if (hasDate) {
    const when = new Date((body.date as string).trim())
    if (Number.isNaN(when.getTime()))
      return { error: 'invalid schedule date/time' }
    return { scheduledFor: when.toISOString() }
  }
  if (hasTime) {
    const minutes =
      typeof body.time === 'number' ? body.time : Number(body.time)
    if (!Number.isFinite(minutes) || minutes <= 0)
      return { error: 'invalid time minutes' }
    return {
      scheduledFor: new Date(Date.now() + minutes * 60_000).toISOString(),
    }
  }
  return { scheduledFor: null }
}

// Resolve the repeating-relaunch flags (`lander relaunch --interval <minutes>`
// [`--repeat-count <n>` | `--repeat-until <when>`]) into a RepeatSpec, or null
// when `--interval` is absent (a one-shot relaunch). `--interval` gates the rest:
// the two bounds are meaningless without a cadence, and mutually exclusive with
// each other. `repeatCount` is the TOTAL number of relaunches in the series
// (including the first), so it maps to `remaining = count - 1` — the number that
// follow the first. `repeatUntil` is a parseable cutoff (same leniency as
// `--date`), stored as an ISO string the re-arm compares each successor against.
function resolveRepeat(body: {
  interval?: unknown
  repeatCount?: unknown
  repeatUntil?: unknown
}): { repeat: RepeatSpec | null } | { error: string } {
  const hasInterval = body.interval !== undefined && body.interval !== null
  const hasCount = body.repeatCount !== undefined && body.repeatCount !== null
  const hasUntil =
    typeof body.repeatUntil === 'string' && body.repeatUntil.trim() !== ''
  if (!hasInterval) {
    if (hasCount || hasUntil)
      return { error: '--repeat-count/--repeat-until require --interval' }
    return { repeat: null }
  }
  const interval =
    typeof body.interval === 'number' ? body.interval : Number(body.interval)
  if (!Number.isFinite(interval) || interval <= 0)
    return { error: 'invalid interval minutes' }
  if (hasCount && hasUntil)
    return { error: '--repeat-count and --repeat-until are mutually exclusive' }
  const repeat: RepeatSpec = { interval }
  if (hasCount) {
    const count =
      typeof body.repeatCount === 'number'
        ? body.repeatCount
        : Number(body.repeatCount)
    if (!Number.isInteger(count) || count < 1)
      return { error: 'invalid repeat count' }
    repeat.remaining = count - 1
  }
  if (hasUntil) {
    const when = new Date((body.repeatUntil as string).trim())
    if (Number.isNaN(when.getTime()))
      return { error: 'invalid repeat-until date/time' }
    repeat.until = when.toISOString()
  }
  return { repeat }
}

// Validate a `--await` body field — the ids a task (or a scheduled message) is
// to wait on. Each must be a real task in this project, so a typo can't either
// strand the waiter or (since a missing id reads as satisfied) wake it at once.
// `selfId` rejects a task awaiting itself. Returns the ids (empty when absent).
async function resolveAwait(
  project: Project,
  value: unknown,
  selfId?: string,
): Promise<{ waitFor: string[] } | { error: string }> {
  if (value === undefined || value === null) return { waitFor: [] }
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string'))
    return { error: '--await expects a list of task ids' }
  const ids = value as string[]
  for (const id of ids) {
    if (!TASK_ID.test(id)) return { error: `invalid await task id: ${id}` }
    if (selfId && id === selfId) return { error: 'a task cannot await itself' }
    if (!(await readTask(project.dataDir, id)))
      return { error: `await task not found: ${id}` }
  }
  // Guard against a deadlock cycle: if any awaited task already waits (directly
  // or transitively) on the awaiter, these edges would close a loop in which
  // each task rests on the next and none can ever land. Only reachable when the
  // awaiter already exists (`rest`, which passes selfId) — a freshly minted
  // `new` id is unreferenced, so its await edges can never close a cycle.
  if (selfId && (await awaitReaches(project, ids, selfId)))
    return { error: 'await would create a cycle' }
  return { waitFor: ids }
}

// Resolve a message's `attachments: id[]` body field to the full refs stored on
// the message: validate each id and look up its metadata sidecar in the project's
// durable store, rejecting any unknown id (a stale/foreign ref the daemon could
// never materialize). Returns [] for the common no-attachments case.
async function resolveAttachments(
  project: Project,
  value: unknown,
): Promise<{ attachments: Attachment[] } | { error: string }> {
  if (value === undefined || value === null) return { attachments: [] }
  if (!Array.isArray(value) || !value.every((x) => typeof x === 'string'))
    return { error: 'attachments expects a list of attachment ids' }
  const out: Attachment[] = []
  for (const id of value as string[]) {
    if (!isAttachmentId(id)) return { error: `invalid attachment id: ${id}` }
    const meta = await readAttachmentMeta(project.attachmentsDir, id)
    if (!meta) return { error: `attachment not found: ${id}` }
    out.push(meta)
  }
  return { attachments: out }
}

// Whether `target` is reachable from `ids` along the waitingFor graph — i.e.
// some awaited task already (transitively) rests on it. Used by resolveAwait to
// reject an await edge that would close a deadlock cycle. The visited set bounds
// the walk and keeps it terminating even over already-cyclic data.
async function awaitReaches(
  project: Project,
  ids: string[],
  target: string,
): Promise<boolean> {
  const seen = new Set<string>()
  const stack = [...ids]
  while (stack.length) {
    const id = stack.pop()!
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    const t = await readTask(project.dataDir, id)
    if (t?.waitingFor?.length) stack.push(...t.waitingFor)
  }
  return false
}

// Snapshot the awaited tasks (id + current title) for an `awaiting` event, so
// the UI can render them as links without a second lookup. A vanished task falls
// back to its short id. Ids are assumed pre-validated by resolveAwait.
async function describeAwaited(
  project: Project,
  ids: string[],
): Promise<{ id: string; title: string }[]> {
  const out: { id: string; title: string }[] = []
  for (const id of ids) {
    const t = await readTask(project.dataDir, id)
    out.push({ id, title: t?.title ?? id.slice(0, 8) })
  }
  return out
}

// True once every awaited task has landed. A missing one (archived/deleted)
// counts as satisfied so a vanished dependency can't strand the waiter forever.
async function awaitSatisfied(
  project: Project,
  ids: string[],
): Promise<boolean> {
  for (const id of ids) {
    const t = await readTask(project.dataDir, id)
    if (t && t.status !== 'landed') return false
  }
  return true
}

// A flowConfig's own bound, distinct from the 64 KiB flowState cap: this is
// launch-time configuration, not accumulated durable state.
const FLOW_CONFIG_MAX_BYTES = 16 * 1024

// Shape and size only — the server never interprets a flowConfig's contents.
function validateFlowConfig(
  value: unknown,
): { config?: Record<string, unknown> } | { error: string } {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value))
    return { error: 'flowConfig must be a JSON object' }
  const size = JSON.stringify(value).length
  if (size > FLOW_CONFIG_MAX_BYTES)
    return {
      error: `flowConfig too large (${size} bytes, max ${FLOW_CONFIG_MAX_BYTES})`,
    }
  return { config: value as Record<string, unknown> }
}

// Unknown values of LANDER_FLOW we've already warned about, so a misconfigured
// env logs once rather than on every task creation.
const warnedUnknownDefaultFlows = new Set<string>()

// The flow for a new task. An EXPLICIT flow that doesn't exist is an error; a
// bad *default* only degrades. That asymmetry is deliberate: making the default
// 400 too would turn a single typo'd LANDER_FLOW into a total task-creation
// outage for the project.
//
// Its registry check runs per request rather than at module scope (as the old
// DEFAULT_NEW_TASK_AGENT
// is), because at boot no daemon has registered and the registry is empty — a
// boot-time check would permanently degrade a perfectly valid
// LANDER_FLOW=open-pr to claude and log a warning that is always wrong. The
// residual window is the same one every registry read lives with: between boot
// and the first register, an unknown-but-valid default degrades to
// LEGACY_FLOW. It fails toward the legacy flow, never toward a mis-dispatch.
function resolveNewTaskFlow(
  slug: string,
  requested: unknown,
): { flow: string } | { error: string } {
  const known = (name: string): boolean =>
    flowRegistry(slug).some((f) => f.name === name)

  if (typeof requested === 'string' && requested.trim()) {
    const name = requested.trim()
    if (!known(name))
      return {
        error:
          `unknown flow: ${name}` +
          ` (available: ${flowRegistry(slug).map((f) => f.name).join(', ') || 'none'})`,
      }
    return { flow: name }
  }

  const fromEnv = DEFAULT_NEW_TASK_FLOW
  if (!fromEnv) return { flow: LEGACY_FLOW }
  if (known(fromEnv)) return { flow: fromEnv }
  if (!warnedUnknownDefaultFlows.has(fromEnv)) {
    warnedUnknownDefaultFlows.add(fromEnv)
    console.warn(
      `default flow '${fromEnv}' is not available; falling back to ${LEGACY_FLOW}`,
    )
  }
  return { flow: LEGACY_FLOW }
}

app.post('/api/:project/tasks', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const body = await c.req.json<{
      title?: unknown
      message?: unknown
      date?: unknown
      time?: unknown
      await?: unknown
      agent?: unknown
      flow?: unknown
      flowConfig?: unknown
      allowEdits?: unknown
      attachments?: unknown
    }>()
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const rawMessage = typeof body.message === 'string' ? body.message : ''

    // An explicitly-named flow must exist. 400 rather than a silent default:
    // inheriting the `isAgentKind(...) ? … : DEFAULT` shape would make
    // `lander launch --flow open-pr` against a daemon lacking it quietly
    // produce a CLAUDE task that runs the prompt — strictly worse than failing.
    const flowResolution = resolveNewTaskFlow(project.slug, body.flow)
    if ('error' in flowResolution) return c.json({ error: flowResolution.error }, 400)
    const flow = flowResolution.flow
    // `agent` is stored only for a legacy flow, so backfillAgents and any
    // pre-flow daemon still see what they expect. Never stored otherwise.
    const agent = isAgentKind(flow) ? flow : undefined

    const flowConfig = validateFlowConfig(body.flowConfig)
    if ('error' in flowConfig) return c.json({ error: flowConfig.error }, 400)
    const allowEdits = body.allowEdits === true
    if (!title && !rawMessage.trim())
      return c.json({ error: 'title or message is required' }, 400)

    // A scheduled/awaiting task is created at rest and launched later by the
    // scheduler. Resolve the launch triggers up front so a bad value fails loudly
    // rather than silently creating a task that never runs. The two combine: the
    // task launches on whichever fires first.
    const sched = resolveSchedule(body)
    if ('error' in sched) return c.json({ error: sched.error }, 400)
    const scheduledFor = sched.scheduledFor ?? undefined
    const awaited = await resolveAwait(project, body.await)
    if ('error' in awaited) return c.json({ error: awaited.error }, 400)
    const waitingFor = awaited.waitFor.length ? awaited.waitFor : undefined
    // Resolve any attachment refs up front so an unknown id fails the request
    // rather than creating a task whose opening message points at nothing.
    const attached = await resolveAttachments(project, body.attachments)
    if ('error' in attached) return c.json({ error: attached.error }, 400)
    const attachments = attached.attachments.length
      ? attached.attachments
      : undefined
    // Only defer when there's actually a message to run later; a deferred task
    // with nothing to do would just sit resting forever.
    const deferred =
      (scheduledFor !== undefined || waitingFor !== undefined) &&
      rawMessage.trim() !== ''

    // Identify the caller once: it gates edit/commit grants below and, when a
    // task spawned this one, supplies the backlink we prepend to the message.
    const principal = await resolvePrincipal(c.req)

    // Granting a spawned task edit access requires a caller that holds it. The
    // human (UI token) may grant it freely; an authenticated task may only pass
    // on edit access it has itself — so a task can't spawn a child more
    // privileged than itself; an unidentified caller may grant nothing.
    if (allowEdits) {
      if (principal.kind === 'task') {
        if (!principal.task.allowEdits)
          return c.json(
            { error: 'spawning task lacks edit permission to pass on' },
            403,
          )
      } else if (principal.kind !== 'ui') {
        return c.json(
          { error: 'not authorized to grant edit permission' },
          403,
        )
      }
    }

    // When a task spawns this one, lead the opening message with a reference back
    // to the spawner so both the agent and a human reader can trace its origin.
    // Emitting the bare spawner id (not a markdown link) lets the client's
    // task-mention linking render it as a status-tinted chip like any other task
    // reference. The title is generated from rawMessage so the backlink can't skew it.
    const message =
      principal.kind === 'task'
        ? `Launched by ${principal.id}:\n\n${rawMessage}`
        : rawMessage

    // Title is optional; when omitted, show a "…" placeholder and have haiku
    // name the task in the background so creation never blocks on it.
    const id = newTaskId()
    const now = new Date().toISOString()
    // The creation event's snapshot of any awaited tasks (for links), computed
    // before we build the record (the readTask calls are async).
    const createdAwaiting =
      deferred && waitingFor
        ? await describeAwaited(project, waitingFor)
        : undefined
    const task: Task = {
      id,
      // Stored only for a legacy flow, so backfillAgents and any pre-flow
      // daemon still see what they expect. `flow` is the field that matters.
      ...(agent ? { agent } : {}),
      flow,
      ...(flowConfig.config ? { flowConfig: flowConfig.config } : {}),
      title: title || '…',
      // Stored status is the collapsed vocabulary (`riding | wedged | landed`). A
      // deferred task stores `riding` with no open ride, so publicTask serves it
      // as `resting` (decorated with scheduledFor) until the scheduler launches
      // it; an immediate task rides while the agent works the opening message; a
      // task with no message is `wedged` — it needs the user to supply a first
      // prompt.
      status: message.trim() || deferred ? 'riding' : 'wedged',
      createdAt: now,
      updatedAt: now,
      // Caught up as of creation: the opening message (and launch event) are the
      // creator's own, so they don't warrant an unseen dot. Anything that lands
      // afterwards — the assistant reply, lifecycle events — is newer than this and
      // shows as unseen until viewed.
      seenAt: now,
      allowEdits,
      // Provenance: when another task spawned this one, remember which, so it can
      // later land what it launched (see the PATCH land gate). A UI-started task
      // has no spawner.
      ...(principal.kind === 'task'
        ? { spawnedBy: principal.id }
        : {}),
      // Authenticates this task's own callbacks (see Task.token).
      token: randomUUID(),
      // A fresh record is born at the current shape.
      shape: 2,
      items: [],
      // The opening message rides the same queue as follow-ups; driveTask drains
      // it (immediately, or when the scheduler launches a deferred task). It stays
      // as a user item in the log above for display.
      queued: message.trim() ? [message] : [],
      // Both triggers persist when deferred; the scheduler fires on whichever
      // comes first. Omitted entirely on an immediate task.
      ...(deferred && scheduledFor ? { scheduledFor } : {}),
      ...(deferred && waitingFor ? { waitingFor } : {}),
    }
    // The creation event, a hair before the opening message so the timeline shows
    // it ahead of that message. A task awaiting other tasks gets an "awaiting"
    // event (carrying them, for links) even with a time fallback — the condition is
    // what's shown; a purely time-deferred task gets "scheduled"; an immediate task
    // gets "launched" (the matching launch is re-recorded when it runs).
    pushEventItem(
      task,
      {
        eventKind: !deferred ? 'launched' : waitingFor ? 'awaiting' : 'scheduled',
        ...(title ? { title } : {}),
        ...(createdAwaiting
          ? { awaiting: createdAwaiting }
          : deferred && scheduledFor
            ? { scheduledFor }
            : {}),
      },
      new Date(Date.parse(now) - 1).toISOString(),
    )
    pushUserItem(task, message, now, attachments ? { attachments } : {})

    await mkdir(project.dataDir, { recursive: true })
    await writeFile(
      path.join(project.dataDir, `${id}.json`),
      JSON.stringify(task, null, 2),
    )

    // Fire-and-forget the title generation; the UI polls and picks it up. If it
    // fails, ensureTitle flags the task so the next wakeup retries.
    if (!title) void ensureTitle(project, id, rawMessage).catch(() => {})

    // Kick off the turn (driveTask hands it to the daemon); reply is appended
    // when it finishes. A deferred task waits for the scheduler instead.
    if (message.trim() && !deferred) void driveTask(project, id)

    return c.json(publicTask(task), 201)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})


// A hook's land: end the target when the judgment is that it is finished.
//
// It shares PATCH rather than getting a route of its own, for the same reason
// the nudge shares /messages. But this route also accepts `wedged` and `riding`
// and gates status changes on nobody, so the hook branch is **whitelisted to
// `landed` and nothing else**: without that, a credential is one field away from
// wedging its target — which hooks.md §8 says a hook never does — and from
// reopening one, which the design gates behind a replay harness that does not
// exist yet.
//
// Landing is preferred to nudging when the target looks done because it is
// reversible where a spent turn is not. That is only true if the wakeups survive,
// and they do not: the `landed` crossing deletes `scheduledFor` and
// `waitingFor`, and a reply restores status while restoring neither. So a target
// holding either trigger is refused, and the reversibility the choice rests on
// becomes a property rather than an assumption.
async function landFromHook(
  c: Context,
  project: Project,
  id: string,
  file: string,
  token: string,
  status: unknown,
  rawKey: unknown,
): Promise<Response> {
  const cred = hookCredentialFor(token, project.slug)
  if (!cred || cred.target !== id)
    return c.json(
      { ok: false, error: 'unknown or expired hook credential', reason: 'credential-unknown' },
      401,
    )
  if (status !== 'landed')
    return c.json(
      { ok: false, error: 'a hook may only set status to landed', reason: 'not-permitted' },
      403,
    )
  const key = typeof rawKey === 'string' && rawKey ? rawKey : ''
  if (!key) return c.json({ ok: false, error: 'key is required' }, 400)

  const now = new Date().toISOString()
  let deduped = false
  try {
    await mutateTask(file, (t) => {
      // Every refusal before the bound, so a refusal never spends a slot.
      // Freshness first: a fire that has been overtaken should not have been
      // acted on at all, whatever the target's current state happens to be.
      if (!freshHookFire(t, cred.fireId)) throw new HookRefusal('stale')
      if (t.status === 'wedged') throw new HookRefusal('wedged')
      // "Not riding" is not what publicTask derives: that reads an open ride or
      // a runId, and neither is set in the window after /messages queues a
      // prompt and before driveTask opens the ride. Landing there would leave a
      // turn riding on a landed task, since the crossing never touches `queued`.
      if (openRide(t) || t.runId || t.queued?.length || running.has(id))
        throw new HookRefusal('riding')
      // The wakeup the crossing would silently delete.
      if (t.scheduledFor || t.waitingFor?.length) throw new HookRefusal('scheduled')

      const accepted = acceptHookAction(t, {
        hook: cred.path,
        fireId: cred.fireId,
        key,
        kind: 'land',
        at: now,
      })
      if (!accepted.ok) throw new HookRefusal(accepted.reason)
      if (accepted.deduped) {
        deduped = true
        return
      }

      // Records the `landed` event and the fire. `byHook` rides onto that fire,
      // so every OTHER hook still sees the landing — which is what lets one
      // chain into cleanup — while the hook that landed the target is not woken
      // by its own landing.
      recordStatusTransition(t, 'landed', now, 'hook', cred.path)
      t.status = 'landed'
      t.updatedAt = now
    })
  } catch (e) {
    // The refusal carries its own prose, because the host reports it verbatim
    // and must not have to know the bound's value — which would mean importing
    // the server's task module into a process spawned fresh for every fire.
    if (e instanceof HookRefusal)
      return c.json({ ok: false, reason: e.reason, error: e.message }, 403)
    throw e
  }
  return c.json({ ok: true, ...(deduped ? { deduped: true } : {}) })
}

app.patch('/api/:project/tasks/:id', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)

    let task: Task
    try {
      task = JSON.parse(await readFile(file, 'utf8')) as Task
    } catch {
      return c.json({ error: 'task not found' }, 404)
    }

    const body = await c.req.json<{
      title?: unknown
      allowEdits?: unknown
      status?: unknown
      key?: unknown
    }>()

    // A hook token means a hook request, answered here rather than fallen
    // through — this route's status change is open to anonymous callers, so a
    // stale credential must not quietly become an ordinary land.
    const hookToken = c.req.header('x-lander-hook-token')
    if (hookToken !== undefined)
      return landFromHook(c, project, id, file, hookToken, body.status, body.key)

    // Resolve the caller once: to gate the privileged allow* change, and to
    // decide whether a wedge should interrupt a live run.
    const principal = await resolvePrincipal(c.req)

    // Changing a task's own edit grant is a privilege escalation, so only the
    // human (UI token) may do it — otherwise a task could PATCH itself to gain
    // access it was never given. Title and status stay open: the CLI's
    // `lander land`/`wedge`/`rest` set status, and renames are harmless.
    if (typeof body.allowEdits === 'boolean' && principal.kind !== 'ui')
      return c.json(
        { error: 'only the UI may change a task’s edit permission' },
        403,
      )

    // A task may land another task only if it spawned it: `lander land <child>`
    // winds down work a task launched, but a task can't reach over and land an
    // unrelated one. Self-land (a task landing itself, the no-id `lander land`)
    // and any UI-initiated land stay unrestricted. Other status changes keep
    // their existing openness — this gate is specifically the land-by-id path.
    if (
      body.status === 'landed' &&
      principal.kind === 'task' &&
      principal.id !== id &&
      task.spawnedBy !== principal.id
    )
      return c.json({ error: 'a task may only land tasks it launched' }, 403)

    // Wedging or landing a riding task from anyone but the task's own CLI stops
    // its in-flight run: the run is being pulled out from under the agent — the
    // human redirecting a wedge, or a spawner winding down a child it launched.
    // A task wedging or landing *itself* is finishing its own turn and runs on.
    // The interrupt fires after the status write below; the run's reducer folds
    // in the partial reply and (applyDone only wedges a still-riding task on a
    // non-deliberate exit) leaves the new non-riding status as-is.
    const selfInitiated =
      principal.kind === 'task' && principal.id === id
    const runId = task.runId
    const interrupt =
      (body.status === 'wedged' || body.status === 'landed') &&
      !selfInitiated &&
      task.status === 'riding' &&
      !!runId

    // Route the write through mutateTask — a fresh read immediately before the
    // atomic rename — so it can't clobber the streaming reducer's concurrent
    // writes. The same reason `rest` does, and load-bearing now that a wedge
    // can arrive mid-run.
    await mutateTask(file, (t) => {
      if (typeof body.title === 'string' && body.title.trim()) {
        const next = body.title.trim()
        // The user named it themselves, so drop any pending retry — their name
        // stands and shouldn't be overwritten on the next wakeup.
        delete t.titlePending
        // A user rename; record it (snapshotting the new name) when it actually
        // changes the title. The initial generated name goes through setTitle,
        // which amends the launch event instead — so it never lands here.
        if (next !== t.title) {
          pushEventItem(t, { eventKind: 'renamed', title: next }, new Date().toISOString())
          t.updatedAt = new Date().toISOString()
        }
        t.title = next
      }
      if (typeof body.allowEdits === 'boolean') t.allowEdits = body.allowEdits
      if (typeof body.status === 'string') {
        const at = new Date().toISOString()
        // Normalize to the collapsed stored vocabulary: the UI's "rest" action
        // (and any client) PATCHes `resting`, but idle is a derived presentation
        // of a `riding` task with no open ride, so store `riding`. publicTask
        // serves `resting` back. wedged/landed store as sent.
        const next = body.status === 'resting' ? 'riding' : body.status
        // A manual land/resume supersedes any open ask; a fresh wedge keeps it.
        // Both fall out of the crossing itself — recordStatusTransition settles
        // open asks on every crossing but the one into `wedged`.
        recordStatusTransition(t, next, at, hookBy(principal, id))
        if (next !== t.status) t.updatedAt = at
        t.status = next
      }
      noteHumanContact(t, principal, new Date().toISOString())
    })

    if (interrupt && runId) await interruptRun(project, runId)

    const updated = await readTask(project.dataDir, id)
    return c.json(publicTask(updated ?? task))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Launch a scheduled task immediately, ahead of its scheduled time (the UI's
// "launch" button on a scheduled task — resting, or wedged on a deferred
// session-limit retry). Clears the schedule, records the "launched" event (and
// the un-wedge, if it was wedged), and drives the queued opening message.
app.post('/api/:project/tasks/:id/launch', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const principal = await resolvePrincipal(c.req)
    const launched = await launchTask(project, id, hookBy(principal, id))
    if (!launched)
      return c.json({ error: 'task is not scheduled' }, 409)
    // Pressing Launch is human contact, so it resets the hook action bound.
    await mutateTask(path.join(project.dataDir, `${id}.json`), (t) => {
      noteHumanContact(t, principal, new Date().toISOString())
    }).catch(() => {})
    const task = await readTask(project.dataDir, id)
    if (!task) return c.json({ error: 'task not found' }, 404)
    return c.json(publicTask(task))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Put a task to rest until a wakeup trigger fires (`lander rest`). Mirrors a
// deferred `new`: it sets scheduledFor and/or waitingFor and records a
// `scheduled` or `awaiting` event, so the scheduler relaunches it on whichever
// trigger fires first. Unlike `new`, the task has already run, so launchTask
// wakes the agent with a generated "Resumed at …" message rather than a queued
// opening one. Called by the in-task CLI while the agent's turn is in flight, so
// it goes through mutateTask to avoid clobbering the concurrent streaming writes.
//
// `{ clear: true }` (`lander rest --clear`) is the inverse: it disarms whatever
// triggers a prior rest (or deferred `new`) armed, taking no trigger of its own.
// The case: the user woke a resting task early (a reply revives it to riding
// without touching the triggers), so the original wakeup is now stale and would
// later fire a spurious "Resumed at …". We only drop the triggers — never touch
// status, and record no event (the past `scheduled`/`awaiting` event stands as
// history of the rest that did happen). Idempotent: clearing nothing succeeds and
// reports `cleared: false`.
app.post('/api/:project/tasks/:id/rest', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)
    if (!(await readTask(project.dataDir, id)))
      return c.json({ error: 'task not found' }, 404)

    // Resolved for attribution, not authorization: this route stays open (the
    // in-task CLI calls it mid-turn), but who rested the task decides which
    // `unwedged/<by>/` hook a revival from a notable status would select.
    const principal = await resolvePrincipal(c.req)

    const body = await c.req.json<{
      date?: unknown
      time?: unknown
      await?: unknown
      clear?: unknown
    }>()

    if (body.clear) {
      if (body.date != null || body.time != null || body.await != null)
        return c.json(
          { error: 'clear takes no trigger (--date/--time/--await)' },
          400,
        )
      let cleared = false
      await mutateTask(file, (t) => {
        cleared = t.scheduledFor != null || (t.waitingFor?.length ?? 0) > 0
        if (!cleared) return
        delete t.scheduledFor
        delete t.waitingFor
        t.updatedAt = new Date().toISOString()
      })
      const task = await readTask(project.dataDir, id)
      if (!task) return c.json({ error: 'task not found' }, 404)
      return c.json({ ...publicTask(task), cleared })
    }

    const sched = resolveSchedule(body)
    if ('error' in sched) return c.json({ error: sched.error }, 400)
    const awaited = await resolveAwait(project, body.await, id)
    if ('error' in awaited) return c.json({ error: awaited.error }, 400)
    const scheduledFor = sched.scheduledFor ?? undefined
    const waitingFor = awaited.waitFor.length ? awaited.waitFor : undefined
    if (!scheduledFor && !waitingFor)
      return c.json(
        { error: 'a time (--date/--time) or condition (--await) is required' },
        400,
      )
    // Snapshot the awaited tasks for the event's links before entering the
    // mutation (the readTask calls are async).
    const awaiting = waitingFor
      ? await describeAwaited(project, waitingFor)
      : undefined

    const at = new Date().toISOString()
    await mutateTask(file, (t) => {
      // Record leaving any notable status (wedged/landed); resting is a derived,
      // quiet presentation, so for the common riding→rest this is a no-op.
      recordStatusTransition(t, 'riding', at, hookBy(principal, id))
      noteHumanContact(t, principal, at)
      // Replace any prior triggers so re-resting doesn't leave a stale one armed.
      if (scheduledFor) t.scheduledFor = scheduledFor
      else delete t.scheduledFor
      if (waitingFor) t.waitingFor = waitingFor
      else delete t.waitingFor
      // An await condition is what's shown (with its links) even alongside a time
      // fallback; a pure time rest keeps the scheduled event.
      pushEventItem(
        t,
        waitingFor
          ? { eventKind: 'awaiting', title: t.title, awaiting }
          : { eventKind: 'scheduled', title: t.title, scheduledFor },
        at,
      )
      // Stored status collapses to `riding`; publicTask serves `resting`
      // (decorated with the scheduledFor/waitingFor set above) since no ride is
      // open. The daemon-driven turn, if one is still streaming, closes its ride
      // on `done`, at which point the rest presentation takes over cleanly.
      t.status = 'riding'
      t.updatedAt = at
    })
    const task = await readTask(project.dataDir, id)
    if (!task) return c.json({ error: 'task not found' }, 404)
    return c.json(publicTask(task))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Relaunch the current task under a fresh provider session, keeping the same
// task id (`lander relaunch`). A task's provider session lives entirely in
// `task.sessionId`, decoupled from the task id: the daemon starts a new session
// whenever it's handed a turn with no `sessionId` (and resumes the same one
// otherwise), so "relaunch under a new session" is just "clear sessionId, then
// drive the next turn" — the session is created lazily on the delivering turn,
// never pre-allocated.
//
// Immediate (no trigger): seal the session now and queue `message` for the next
// turn (applyRelaunch). Called mid-turn of the old session in the normal path, so
// the in-flight driveTask loop drains the queued message after the current turn's
// `done`; because the session is now sealed, that turn hands the daemon no
// session and a fresh one is minted. The old turn is never interrupted — only
// next-turn state is touched — so it keeps streaming into its old reply until
// `done`, the 'relaunched' event renders as the divider, and the queued message
// is dimmed until the new session reads it.
//
// Scheduled (`--date`/`--time`/`--await`): seal AT the trigger, not now. Stash a
// relaunch-flagged scheduled message (armScheduledRelaunch); the old session
// stays live until the trigger, so pre-trigger interim messages resume it, and
// deliverScheduledMessages seals + drives when it fires. We don't set task-level
// `scheduledFor` (that would block delivery and could double-fire launchTask) —
// the message's own trigger drives it.
//
// `{ clear: true }` drops a pending scheduled relaunch (the relaunch-flagged
// scheduled messages); it leaves the armed 'relaunched' event as history, like
// `rest --clear` leaves its 'scheduled' event. Only the task itself or the UI may
// relaunch — a task relaunches its own session.
app.post('/api/:project/tasks/:id/relaunch', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)
    if (!(await readTask(project.dataDir, id)))
      return c.json({ error: 'task not found' }, 404)

    const principal = await resolvePrincipal(c.req)
    if (
      principal.kind !== 'ui' &&
      !(principal.kind === 'task' && principal.id === id)
    )
      return c.json({ error: 'only the task itself may relaunch its session' }, 403)

    const body = await c.req.json<{
      message?: unknown
      date?: unknown
      time?: unknown
      await?: unknown
      interval?: unknown
      repeatCount?: unknown
      repeatUntil?: unknown
      clear?: unknown
    }>()

    // Drop a pending scheduled relaunch armed earlier — the analog of `rest
    // --clear`. Removes only the relaunch-flagged scheduled messages (an ordinary
    // `lander send` deferral is untouched); idempotent, reporting whether anything
    // was disarmed.
    if (body.clear) {
      if (body.date != null || body.time != null || body.await != null)
        return c.json(
          { error: 'clear takes no trigger (--date/--time/--await)' },
          400,
        )
      let cleared = false
      await mutateTask(file, (t) => {
        const pending = t.scheduledMessages ?? []
        const rest = pending.filter((m) => !m.relaunch)
        cleared = rest.length !== pending.length
        if (!cleared) return
        if (rest.length) t.scheduledMessages = rest
        else delete t.scheduledMessages
        t.updatedAt = new Date().toISOString()
      })
      const task = await readTask(project.dataDir, id)
      if (!task) return c.json({ error: 'task not found' }, 404)
      return c.json({ ...publicTask(task), cleared })
    }

    const rawMessage = typeof body.message === 'string' ? body.message : ''
    if (!rawMessage.trim()) return c.json({ error: 'message is required' }, 400)

    // A `--date`/`--time` and/or `--await` relaunch defers the seal to the
    // trigger; absent all, seal now. Mirror `lander send`'s trigger resolution.
    const sched = resolveSchedule(body)
    if ('error' in sched) return c.json({ error: sched.error }, 400)
    const awaited = await resolveAwait(project, body.await)
    if ('error' in awaited) return c.json({ error: awaited.error }, 400)
    // `--interval` (with an optional `--repeat-count`/`--repeat-until` bound) makes
    // the relaunch repeat: each occurrence arms the next one `interval` minutes
    // later. Absent `--interval` it's a one-shot, as before.
    const rep = resolveRepeat(body)
    if ('error' in rep) return c.json({ error: rep.error }, 400)
    const deliverAt = sched.scheduledFor ?? undefined
    const waitFor = awaited.waitFor.length ? awaited.waitFor : undefined
    const repeat = rep.repeat ?? undefined

    const at = new Date().toISOString()

    if (deliverAt || waitFor) {
      // Scheduled (B): arm a relaunch-flagged scheduled message; the session is
      // sealed by deliverScheduledMessages when the trigger fires, not now. A
      // repeat spec rides along and re-arms the next occurrence on each delivery.
      await mutateTask(file, (t) => {
        armScheduledRelaunch(t, { text: rawMessage, deliverAt, waitFor, repeat }, at)
      })
      const armed = await readTask(project.dataDir, id)
      if (!armed) return c.json({ error: 'task not found' }, 404)
      return c.json(publicTask(armed))
    }

    // Immediate (A): seal now and queue the message for the fresh session. A
    // repeat spec arms the first successor off this delivery.
    await mutateTask(file, (t) => {
      applyRelaunch(t, rawMessage, at, hookBy(principal, id), repeat)
      noteHumanContact(t, principal, at)
      // Same as /messages: the crossing inside applyRelaunch covers a
      // wedged/landed task, and this covers the advisory ask on a task that was
      // riding all along, where there's no crossing to carry the rule.
      withdrawOpenAsks(t)
    })
    // The normal path is a mid-turn call, where running.has(id) is already true:
    // the in-flight drainer picks up the queued message and the sealed session
    // mints a fresh one. If nothing is running (e.g. relaunching a rested/landed
    // task), start a drainer now.
    if (!running.has(id)) void driveTask(project, id)

    const updated = await readTask(project.dataDir, id)
    if (!updated) return c.json({ error: 'task not found' }, 404)
    return c.json(publicTask(updated))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Whether a path is the project root or lives under it (a subdir or a worktree at
// `.claude/worktrees/<name>`, both of which sit inside root). Used to bound the
// recorded cwd so a wandered `/tmp` or sibling-repo path is never persisted.
function isUnderRoot(root: string, p: string): boolean {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// The session's working directory (and transcript path) at the end of a turn,
// posted by the Stop hook via `lander record-cwd`. Persisted so the next turn
// resumes here instead of the project root — see Task.cwd and runTurn. Only the
// task itself (authenticating with its own token) or the UI may set it. A bare
// cwd write isn't a turn boundary, so it doesn't bump updatedAt or emit an
// event — it's invisible to the sort order and the timeline.
app.post('/api/:project/tasks/:id/cwd', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)
    if (!(await readTask(project.dataDir, id)))
      return c.json({ error: 'task not found' }, 404)

    const principal = await resolvePrincipal(c.req)
    if (
      principal.kind !== 'ui' &&
      !(principal.kind === 'task' && principal.id === id)
    )
      return c.json({ error: 'only the task itself may record its cwd' }, 403)

    const body = await c.req.json<{ cwd?: unknown; transcriptPath?: unknown }>()
    if (typeof body.cwd !== 'string' || !body.cwd)
      return c.json({ error: 'cwd is required' }, 400)
    const cwd = body.cwd
    // An independent server-side bound: only persist a cwd under the project root
    // (the root itself, a subdir, or a `.claude/worktrees/<name>` — all of which
    // live under it). A wandered `/tmp` or sibling-repo cwd is dropped, so it can
    // never become the next turn's launch dir regardless of adapter. The daemon's
    // launch-at-root already neutralizes the practical harm for Claude; this caps
    // Codex's resume-from-recorded-cwd (and its one cross-repo gitCommonDir edge).
    if (!isUnderRoot(project.path, cwd))
      return c.json({ error: 'cwd must be under the project root' }, 400)
    const transcriptPath =
      typeof body.transcriptPath === 'string' ? body.transcriptPath : undefined

    await mutateTask(file, (t) => {
      t.cwd = cwd
      if (transcriptPath) t.transcriptPath = transcriptPath
    })
    const task = await readTask(project.dataDir, id)
    if (!task) return c.json({ error: 'task not found' }, 404)
    return c.json(publicTask(task))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// The git worktree the agent is currently in, tracked by provider hooks such as
// Claude's Enter/ExitWorktree PostToolUse hooks (`lander record-worktree` /
// `clear-worktree`) so every turn can relaunch with the right daemon-side
// worktree behavior.
// POST records it from EnterWorktree's reported `worktreePath` (only a path under
// this project's worktrees dir is accepted, so a stray path can't strand turns
// behind a bogus flag); DELETE clears it on exit. Like /cwd, only the task itself
// or the UI may write, and neither is a turn boundary (no updatedAt, no event).
app.post('/api/:project/tasks/:id/worktree', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)
    const existing = await readTask(project.dataDir, id)
    if (!existing)
      return c.json({ error: 'task not found' }, 404)

    const principal = await resolvePrincipal(c.req)
    if (
      principal.kind !== 'ui' &&
      !(principal.kind === 'task' && principal.id === id)
    )
      return c.json({ error: 'only the task itself may record its worktree' }, 403)

    const body = await c.req.json<{ worktreePath?: unknown }>()
    if (typeof body.worktreePath !== 'string' || !body.worktreePath)
      return c.json({ error: 'worktreePath is required' }, 400)
    const name = worktreeName(project.path, body.worktreePath)
    if (!name) return c.json({ error: 'not a worktree of this project' }, 400)

    await mutateTask(file, (t) => {
      t.worktree = name
    })
    const task = await readTask(project.dataDir, id)
    if (!task) return c.json({ error: 'task not found' }, 404)
    return c.json(publicTask(task))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

app.delete('/api/:project/tasks/:id/worktree', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)
    if (!(await readTask(project.dataDir, id)))
      return c.json({ error: 'task not found' }, 404)

    const principal = await resolvePrincipal(c.req)
    if (
      principal.kind !== 'ui' &&
      !(principal.kind === 'task' && principal.id === id)
    )
      return c.json({ error: 'only the task itself may clear its worktree' }, 403)

    await mutateTask(file, (t) => {
      delete t.worktree
    })
    const task = await readTask(project.dataDir, id)
    if (!task) return c.json({ error: 'task not found' }, 404)
    return c.json(publicTask(task))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Archive or restore a task by moving its JSON between the project's tasks/ and
// archived/ dirs. Archiving takes a (non-riding) task out of the list and out of
// the scheduler's and recovery's view — both of which scan only tasks/ — so an
// archived task is inert; restoring (`{ archived: false }`) moves it back. A
// riding task can't be archived: it has a live run the reducer must keep
// reattaching to, so the caller has to let it come to rest first.
app.post('/api/:project/tasks/:id/archive', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const body = await c.req
      .json<{ archived?: unknown }>()
      .catch(() => ({}) as { archived?: unknown })
    const archived = body.archived !== false // default: archive
    const fromDir = archived ? project.dataDir : project.archiveDir
    const toDir = archived ? project.archiveDir : project.dataDir
    const task = await readTask(fromDir, id)
    if (!task)
      return c.json(
        { error: archived ? 'task not found' : 'archived task not found' },
        404,
      )
    // Only a task with a *live* run can't be archived (the reducer must keep
    // writing to it). Key on the run, not stored status — under the collapse an
    // idle "resting" task stores `riding` too, and it must stay archivable.
    //
    // `running` is part of that test and not a belt-and-braces addition: a drive
    // records its runId only after `awaitDaemonServing` returns, which is up to
    // 30s of a task that is riding with nothing on the record to say so. Archived
    // in that window, the turn goes on to write its run pointer to a path that has
    // moved to archived/ — an ENOENT with no handler (deliberately: a pointer that
    // failed to land must not dispatch a run nothing can reattach to), which takes
    // the whole server down. The window is widest exactly when a user is most
    // likely to give up and archive, because a daemon that is down is what holds
    // the drive there.
    if (archived && (running.has(id) || task.runId || openRide(task)))
      return c.json({ error: 'cannot archive a task while it is riding' }, 409)
    await mkdir(toDir, { recursive: true })
    await rename(path.join(fromDir, `${id}.json`), path.join(toDir, `${id}.json`))
    return c.json(publicTask({ ...task, archived }))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Re-title a task from its conversation (its user messages — see below). Unlike
// the background generation at creation time, this blocks and returns the updated
// task so the UI can show the new title immediately.
app.post('/api/:project/tasks/:id/retitle', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)

    const task = await readTask(project.dataDir, id)
    if (!task) return c.json({ error: 'task not found' }, 404)

    // Title from the user's own messages only. The goal lives in what the user
    // asked for; the assistant's replies are execution detail that dominates the
    // transcript by volume and pulls titles off-goal and over-length.
    const goal = userItems(task)
      .map((m) => m.text)
      .join('\n\n')
    const next = await generateTitle(project.path, goal)
    // Generation failed — keep the current title rather than blanking it.
    if (!next) return c.json(publicTask(task))
    // Apply through mutateTask (a fresh read under the per-file lock) so the
    // slow generateTitle above didn't read a task that a concurrent run has
    // since written — the rename would otherwise clobber that streamed update.
    await mutateTask(file, (t) => {
      // This deliberate naming settles the title, so a pending retry from an
      // earlier failure shouldn't fire on the next wakeup and overwrite it.
      delete t.titlePending
      // A deliberate re-title (the "suggest a title" button), so record it as a
      // rename — unlike the automatic first naming, which amends the launch event.
      if (next !== t.title) {
        pushEventItem(t, { eventKind: 'renamed', title: next }, new Date().toISOString())
        t.updatedAt = new Date().toISOString()
      }
      t.title = next
    })
    const updated = await readTask(project.dataDir, id)
    return c.json(publicTask(updated ?? task))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// A hook's nudge: append a finding to the target and drive a turn, without the
// side effects an ordinary message delivery carries.
//
// It shares this route rather than getting one of its own, because the shared
// core — append, queue, drive — is the whole of what a nudge does, and a parallel
// route is how two paths drift. What differs is small and each difference is
// deliberate:
//
//   - the item is `role: 'hook'`, not `role: 'user'` (see MessageItem);
//   - the wakeup is NOT disarmed, because for a resting supervised target that
//     wakeup is what would have woken it anyway;
//   - an open ask is NOT withdrawn, so an advisory question survives a nudge;
//   - `t.retry` is not touched — unreachable anyway, since a task holding one is
//     wedged and a wedged target is refused below.
//
// The status crossing is a parameter rather than a suppression: a resting target
// stores `riding`, so recordStatusTransition returns early and there is nothing
// to suppress; a landed one crosses `unlanded`, which is wanted.
async function nudgeFromHook(
  c: Context,
  project: Project,
  id: string,
  file: string,
  token: string,
  rawMessage: string,
  rawKey: unknown,
): Promise<Response> {
  const cred = hookCredentialFor(token, project.slug)
  // Scoped to one target as well as one project: a credential minted for one
  // task cannot act on another.
  if (!cred || cred.target !== id)
    return c.json(
      { ok: false, error: 'unknown or expired hook credential', reason: 'credential-unknown' },
      401,
    )
  const key = typeof rawKey === 'string' && rawKey ? rawKey : ''
  if (!key) return c.json({ ok: false, error: 'key is required' }, 400)

  const now = new Date().toISOString()
  // Attribution is composed here, from the credential, so a body cannot forge
  // it. The same string goes in the item and on the queue: a prompt has no
  // roles, so the agent learns who spoke only from the text.
  const message = `From hook ${cred.name}:\n\n${rawMessage}`

  let deduped = false
  try {
    await mutateTask(file, (t) => {
      // Every refusal BEFORE the bound, so a refused action never spends one of
      // three slots. Inside the lock, because the route's earlier read is
      // outside mutateTask's per-file chain and a target that wedges in between
      // would otherwise be nudged anyway.
      //
      // A wedged task is holding a question for its human — `lander wedge
      // --option`, or the platform's retry ask — and the `unwedged` crossing
      // would withdraw it. Refusing is not the loss it looks like: hooks.md §2
      // already excludes retry-after-usage-limit from hooks, and a nudge there
      // would orphan the `task.retry` stash that the retry exists to re-send.
      // A held fire can outlive the state it was recorded against; nudging then
      // carries a finding about work the target has already moved past.
      if (!freshHookFire(t, cred.fireId)) throw new HookRefusal('stale')
      if (t.status === 'wedged') throw new HookRefusal('wedged')

      const accepted = acceptHookAction(t, {
        hook: cred.path,
        fireId: cred.fireId,
        key,
        kind: 'nudge',
        at: now,
      })
      if (!accepted.ok) throw new HookRefusal(accepted.reason)
      if (accepted.deduped) {
        deduped = true
        return
      }

      // A hair before the message, so the timeline shows the revival ahead of
      // what caused it. `by: 'hook'` literally, not via hookBy: that maps a
      // Principal, and a hook request resolves `anon` → `system`, which would
      // file the fire under a directory no hook selector names.
      recordStatusTransition(
        t,
        'riding',
        new Date(Date.parse(now) - 1).toISOString(),
        'hook',
        cred.path,
      )
      pushHookMessageItem(t, message, {
        hook: cred.name,
        path: cred.path,
        fireId: cred.fireId,
      }, now)
      t.updatedAt = now
      t.queued = [...(t.queued ?? []), message]
      // recordStatusTransition deliberately does not assign status. Without this
      // a nudged landed task would ride while stored `landed`, be served
      // `landed`, and cross `unlanded` again on the next nudge.
      t.status = 'riding'
    })
  } catch (e) {
    // Only a refusal is an answer; anything else — a missing or corrupt task
    // file, which rejects from the same call — is a fault, and reporting it to
    // the body as `bound` would be a lie.
    // The refusal carries its own prose, because the host reports it verbatim
    // and must not have to know the bound's value — which would mean importing
    // the server's task module into a process spawned fresh for every fire.
    if (e instanceof HookRefusal)
      return c.json({ ok: false, reason: e.reason, error: e.message }, 403)
    throw e
  }

  if (!deduped && !running.has(id)) void driveTask(project, id)
  return c.json({ ok: true, ...(deduped ? { deduped: true } : {}) })
}

app.post('/api/:project/tasks/:id/messages', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)

    let task: Task
    try {
      task = JSON.parse(await readFile(file, 'utf8')) as Task
    } catch {
      return c.json({ error: 'task not found' }, 404)
    }

    const body = await c.req.json<{
      message?: unknown
      date?: unknown
      time?: unknown
      await?: unknown
      attachments?: unknown
      key?: unknown
    }>()
    const rawMessage = typeof body.message === 'string' ? body.message : ''
    if (!rawMessage.trim()) return c.json({ error: 'message is required' }, 400)

    // The nudge. A request carrying a hook token IS a hook request — resolved
    // here, before resolvePrincipal, and answered rather than fallen through. An
    // expired credential must not quietly become an anonymous `role: 'user'`
    // append: this route accepts anonymous callers, so falling through would let
    // a timeout change who the record says spoke.
    const hookToken = c.req.header('x-lander-hook-token')
    if (hookToken !== undefined)
      return nudgeFromHook(c, project, id, file, hookToken, rawMessage, body.key)

    // A task may only message tasks in its own project (the human, via the UI
    // token, may message any). The `lander send` CLI always targets the caller's
    // own project, so this just enforces that server-side.
    const principal = await resolvePrincipal(c.req)
    if (principal.kind === 'task' && principal.slug !== c.req.param('project'))
      return c.json(
        { error: 'a task may only message tasks in its own project' },
        403,
      )

    // When one task messages another, lead with a backlink to the sender, just
    // like the spawn backlink, so the recipient (and a human reader) can trace
    // who sent it. Emitting the bare sender id (not a markdown link) lets the
    // client's task-mention linking render it as a status-tinted chip like any
    // other task reference. A task messaging itself, or the human via the UI, is
    // bare.
    const message =
      principal.kind === 'task' && principal.id !== id
        ? `From ${principal.id}:\n\n${rawMessage}`
        : rawMessage

    // A `--date`/`--time` and/or `--await` send defers delivery; absent all,
    // deliver now.
    const sched = resolveSchedule(body)
    if ('error' in sched) return c.json({ error: sched.error }, 400)
    const awaited = await resolveAwait(project, body.await)
    if ('error' in awaited) return c.json({ error: awaited.error }, 400)
    const attached = await resolveAttachments(project, body.attachments)
    if ('error' in attached) return c.json({ error: attached.error }, 400)
    const attachments = attached.attachments.length
      ? attached.attachments
      : undefined
    const deliverAt = sched.scheduledFor ?? undefined
    const waitFor = awaited.waitFor.length ? awaited.waitFor : undefined

    if (deliverAt || waitFor) {
      // Stash on the recipient; the scheduler delivers and drives it when the
      // trigger fires (the due time or all awaited tasks landing, whichever
      // first). Don't touch status or queue now — the recipient may be resting
      // (or even landed) until then. mutateTask avoids clobbering a concurrent
      // run. Any attachments ride along until delivery (see applyDueMessages).
      await mutateTask(file, (t) => {
        ;(t.scheduledMessages ??= []).push({
          text: message,
          deliverAt,
          waitFor,
          ...(attachments ? { attachments } : {}),
        })
      })
      const updated = await readTask(project.dataDir, id)
      return c.json(publicTask(updated ?? task))
    }

    const now = new Date().toISOString()
    // Through mutateTask (fresh read under the per-file lock) so queueing the
    // message can't clobber a run that's streaming into the same task — the
    // comment below notes a run may already be in flight.
    await mutateTask(file, (t) => {
      // Sending revives a wedged or landed (terminal) task — record the
      // "un-wedged"/"un-landed" transition a hair before the message's own
      // timestamp so the timeline shows it ahead of the message that caused it.
      recordStatusTransition(
        t,
        'riding',
        new Date(Date.parse(now) - 1).toISOString(),
        hookBy(principal, id),
      )
      noteHumanContact(t, principal, now)
      // An out-of-band wake supersedes a *timer*: the task is riding now, so the
      // wakeup it armed would fire later against a task that has moved on (and,
      // in every case we've observed, already landed) and burn a ride announcing
      // it has nothing to do. Disarm it here and tell the woken turn, naming the
      // time so re-arming is a single actionable step. An `await`, by contrast,
      // stays armed — it's a real dependency on sibling tasks, and an unrelated
      // message must not cancel it. Same rule the wake-delivery table states for
      // the daemon path (docs/daemon-wakeups.md §Delivery).
      //
      // Stamped here rather than in recordStatusTransition because the resting
      // case can't ride that funnel at all: riding↔resting isn't a crossing (both
      // store as `riding`), so it returns early. Merged into whatever the
      // crossing above stamped — a wedged task can hold a retry wakeup, so both
      // halves can apply to one revival.
      if (t.scheduledFor) {
        t.revived = {
          ...t.revived,
          restUntil: new Date(t.scheduledFor).toLocaleString(),
        }
        delete t.scheduledFor
      }
      pushUserItem(t, message, now, attachments ? { attachments } : {})
      t.updatedAt = now
      // Queue the prompt for the session and go "riding". driveTask clears it to
      // "resting" once the queue drains.
      t.queued = [...(t.queued ?? []), message]
      t.status = 'riding'
      // A fresh message is the user's new intent; drop any pending retry so its
      // button doesn't linger over the revived conversation.
      delete t.retry
      // Reviving a wedged/landed task already withdrew its ask on the crossing
      // above. This is for the case with no crossing to ride: an advisory
      // `lander ask` left a question open on a task that never stopped riding,
      // and answering it by just typing instead is the documented way out.
      withdrawOpenAsks(t)
    })

    // If a run is already in flight it will drain this message when it
    // finishes; otherwise start a drainer to resume the session now.
    if (!running.has(id)) void driveTask(project, id)

    return c.json(publicTask(task))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Raise an ask on a task: a stored question that, when task-blocking, wedges the
// task until it's answered; when advisory (`blocking: 'none'`, `lander ask`) it
// leaves the status alone — the task rests with the question attached, nothing in
// the list. Principal: the task itself (posting its own ask mid-turn —
// self-initiated, so no run interrupt, exactly like `lander wedge`) or the UI
// (mirror the artifact-publish gate). Ride-blocking (`ride`) ships in the
// vocabulary but 400s here until its behavior exists.
app.post('/api/:project/tasks/:id/asks', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)
    if (!(await readTask(project.dataDir, id)))
      return c.json({ error: 'task not found' }, 404)

    const principal = await resolvePrincipal(c.req)
    if (
      principal.kind !== 'ui' &&
      !(principal.kind === 'task' && principal.id === id)
    )
      return c.json({ error: 'only the task itself may raise its asks' }, 403)

    const body = await c.req.json<{
      prompt?: unknown
      form?: unknown
      blocking?: unknown
    }>()
    // Prompt is optional: an agent wedge omits it (its own message is the
    // question). Only the form is required.
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const formError = validateAskForm(body.form)
    if (formError) return c.json({ error: formError }, 400)
    const form = body.form as AskForm
    // Task-blocking (`lander wedge --option`) and advisory (`lander ask`,
    // blocking: 'none') asks are reachable; ride-blocking (long-poll) isn't
    // implemented, so reject rather than store a shape whose behavior doesn't
    // exist yet.
    const blocking = body.blocking ?? 'task'
    if (blocking !== 'task' && blocking !== 'none')
      return c.json(
        { error: `blocking: '${blocking}' is not implemented yet` },
        400,
      )

    let created: Ask | undefined
    await mutateTask(file, (t) => {
      const at = new Date().toISOString()
      const askId = nextAskId(t, Date.now())
      // The last ask raised in a turn wins: a fresh ask supersedes any still open
      // (the agent has no way to withdraw one to revise it). This also keeps the
      // "at most one open ask" invariant the UI relies on. Mint the id first —
      // withdrawing doesn't change the ask count, so the seq stays correct.
      withdrawOpenAsks(t)
      // A task-blocking ask wedges the task in the same write, recording the
      // crossing so it surfaces in the timeline (decision 2). driveTask's finally
      // only demotes riding→resting, so a wedge set here survives a self-post. A
      // `none` ask leaves the status untouched — the task rests, nothing in the
      // list — and only the create endpoint ever wedges, never un-wedges.
      if (blocking === 'task') {
        recordStatusTransition(t, 'wedged', at, hookBy(principal, id))
        t.status = 'wedged'
      }
      t.updatedAt = at
      // Agent-raised asks anchor to the ride that raised them, so the form
      // renders as that turn's footer. Raised with no ride in flight (e.g. by
      // the UI principal), the ask stands alone in the timeline instead.
      const rideId = openRide(t)?.id
      created = wireAsk(
        createAsk(t, {
          id: askId,
          ...(prompt ? { prompt } : {}),
          form,
          blocking,
          ...(rideId ? { rideId } : {}),
          at,
        }),
      )
    })
    return c.json({ ask: created }, 201)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Answer an ask (UI principal only, like /retry — answering re-drives the
// session). Stamps the answer and un-wedges: a chosen option carrying a future
// `at` stays wedged and schedules the delivery for then (via scheduledFor, drained
// by launchTask — exactly the deferred-retry path); otherwise the task goes riding
// now and the answer is delivered as a visible user message. An `origin: 'retry'`
// ask delivers nothing of its own — the retry-recovery machinery composes the
// turn (added in the wedge recast).
app.post('/api/:project/tasks/:id/asks/:askId/answer', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const askId = c.req.param('askId')
    const file = path.join(project.dataDir, `${id}.json`)
    if (!(await readTask(project.dataDir, id)))
      return c.json({ error: 'task not found' }, 404)

    if ((await resolvePrincipal(c.req)).kind !== 'ui')
      return c.json({ error: 'not authorized to answer' }, 403)

    const body = await c.req.json<{ optionId?: unknown; text?: unknown }>()
    const optionId = typeof body.optionId === 'string' ? body.optionId : undefined
    const text = typeof body.text === 'string' ? body.text : undefined

    const now = new Date().toISOString()
    const before = new Date(Date.parse(now) - 1).toISOString()
    let fail: { error: string; status: 404 | 409 | 400 } | undefined
    let defer = false
    await mutateTask(file, (t) => {
      const res = answerAsk(t, askId, { optionId, text, at: now })
      if (!res.ok) {
        fail = { error: res.error, status: res.status }
        return
      }
      // UI-only route, so answering an ask is always human contact — and it is
      // the whole of some tasks' human interaction, which is why the bound reset
      // cannot live in `/messages` alone.
      noteHumanContact(t, { kind: 'ui' }, now)
      const ask = res.ask
      const opt = chosenOption(ask)
      const scheduleAt = opt?.at
      defer = !!scheduleAt && Date.parse(scheduleAt) > Date.now()
      // A platform retry ask routes through the retry-recovery machinery instead
      // of a generic delivery: retry-now recovers immediately, retry-at-reset (a
      // future option `at`) schedules the recovery for then. It composes its own
      // turn (nudge or prompt re-send) from the `retry` stash.
      if (ask.origin === 'retry') {
        applyRetryRecovery(t, { defer, resetsAt: scheduleAt, now, by: 'human' })
        return
      }
      // Deliver the answer as a visible user message so it appears in the
      // re-entry prompt; a plain answer's text is queued for the session.
      const delivery = answerDelivery(ask)
      if (delivery != null) {
        pushUserItem(t, delivery, now)
        t.queued = [...(t.queued ?? []), delivery]
      }
      if (defer && scheduleAt) {
        // Scheduling is not an un-wedge: stay wedged (the moon shows via
        // scheduledFor) until launchTask fires the wakeup and drains the
        // queued delivery — mirrors the deferred retry exactly.
        t.scheduledFor = scheduleAt
        pushEventItem(
          t,
          { eventKind: 'scheduled', title: t.title, scheduledFor: scheduleAt },
          now,
        )
      } else {
        recordStatusTransition(t, 'riding', before, 'human')
        t.status = 'riding'
      }
      t.updatedAt = now
    })
    if (fail) return c.json({ error: fail.error }, fail.status)
    if (!defer && !running.has(id)) void driveTask(project, id)

    const updated = await readTask(project.dataDir, id)
    return c.json(publicTask(updated ?? (await readTask(project.dataDir, id))!))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Grant a permission rule the agent was blocked on. scope "task" appends it to
// this task's `allow` list; scope "project" asks the daemon to persist it in the
// provider-specific project config. The rule comes from the popup's textarea, so
// the user may have edited it before granting.
app.post('/api/:project/tasks/:id/allow', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)

    // Granting a tool rule widens what the agent can run, so it's the human's
    // call: only the UI may do it. A task can't self-grant past its sandbox.
    if ((await resolvePrincipal(c.req)).kind !== 'ui')
      return c.json({ error: 'not authorized to grant tool permissions' }, 403)

    const body = await c.req.json<{ rule?: unknown; scope?: unknown }>()
    const rule = typeof body.rule === 'string' ? body.rule.trim() : ''
    const scope = body.scope === 'project' ? 'project' : 'task'
    if (!rule) return c.json({ error: 'rule is required' }, 400)

    const task = await readTask(project.dataDir, id)
    if (!task) return c.json({ error: 'task not found' }, 404)
    // Derived from the flow name, like start-run's — and `agent` sent only for
    // a legacy kind, since there is no legal AgentKind for any other flow.
    const grantFlow = taskFlow(task)
    const grantAgent = isAgentKind(grantFlow) ? grantFlow : undefined

    let warning: string | undefined
    if (scope === 'project') {
      const result = await requestProjectGrant({
        project: project.slug,
        agent: grantAgent,
        flow: grantFlow,
        rule,
      })
      if (!result.ok)
        return c.json(
          { error: result.error ?? 'project grant failed' },
          (result.status ?? 500) as ContentfulStatusCode,
        )
      // A project-scope grant is human contact too — the rule is persisted
      // outside the task, but the human answering the prompt is the same signal.
      // Best-effort: the grant already succeeded, so a failure to stamp must not
      // fail the request.
      await mutateTask(file, (t) => {
        noteHumanContact(t, { kind: 'ui' }, new Date().toISOString())
      }).catch(() => {})
    } else {
      try {
        await mutateTask(file, (t) => {
          const allow = (t.allow ??= [])
          if (!allow.includes(rule)) allow.push(rule)
          // Answering a permission prompt is human contact — this route is
          // UI-only, and for some tasks it is the whole of the human's
          // involvement.
          noteHumanContact(t, { kind: 'ui' }, new Date().toISOString())
        })
      } catch {
        return c.json({ error: 'task not found' }, 404)
      }
      // Key off the flow's announced capability, not the agent name: a flow
      // that saves task rules for parity but doesn't honor them (task cap
      // false) gets the "saved for parity" warning. Byte-identical today —
      // claude's task cap is true and codex's false, announced and bootstrap
      // alike — and it is what lets a non-legacy flow, which has no AgentKind
      // to pass here at all, be answered correctly.
      if (!flowCaps(grantFlow).grants.task)
        warning = TASK_ALLOW_UNSUPPORTED_WARNING
    }
    return c.json({ ok: true, rule, scope, ...(warning ? { warning } : {}) })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Mark a task seen up to the given ISO timestamp, clearing its unseen-update dot
// in the UI. Advances `seenAt` monotonically — a stale or out-of-order `at`
// never moves the marker backwards — so the browser can fire these freely as the
// viewer reads. This is harmless view-state, so it isn't principal-gated.
app.post('/api/:project/tasks/:id/seen', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)

    const body = await c.req.json<{ at?: unknown }>()
    const at = typeof body.at === 'string' ? body.at : ''
    if (!at) return c.json({ error: 'at is required' }, 400)

    // The task lives in tasks/ while active and in archived/ once archived; an
    // archived row can still show an unseen dot, so look in both. Without the
    // fallback the mark silently 404s for archived tasks: the dot clears
    // optimistically in the UI, then the next poll restores the stale marker and
    // it flickers back.
    const file = (await readTask(project.dataDir, id))
      ? path.join(project.dataDir, `${id}.json`)
      : path.join(project.archiveDir, `${id}.json`)

    // Read-modify-write under mutateTask so a concurrent streaming update (which
    // rewrites the same file) can't clobber, or be clobbered by, this marker.
    let updated: Task | null = null
    try {
      await mutateTask(file, (t) => {
        if (!t.seenAt || at > t.seenAt) t.seenAt = at
        updated = t
      })
    } catch {
      return c.json({ error: 'task not found' }, 404)
    }
    return c.json(publicTask(updated!))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Mark a task unread, re-showing its unseen-update dot in the UI. Resets
// `seenAt` to "" — "caught up to nothing" — so the task's latest update reads as
// unviewed again; the next /seen call advances the marker forward as the viewer
// reads. Unlike /seen this deliberately moves the marker backwards, so it sets
// unconditionally. Harmless view-state, so it isn't principal-gated.
app.post('/api/:project/tasks/:id/unread', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!TASK_ID.test(id)) return c.json({ error: 'invalid task id' }, 400)

    // Look in both tasks/ and archived/, mirroring /seen: an archived row can
    // carry an unseen dot too, and either should be markable unread.
    const file = (await readTask(project.dataDir, id))
      ? path.join(project.dataDir, `${id}.json`)
      : path.join(project.archiveDir, `${id}.json`)

    // Read-modify-write under mutateTask so a concurrent streaming update can't
    // clobber, or be clobbered by, this marker.
    let updated: Task | null = null
    try {
      await mutateTask(file, (t) => {
        t.seenAt = ''
        updated = t
      })
    } catch {
      return c.json({ error: 'task not found' }, 404)
    }
    return c.json(publicTask(updated!))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// On boot, recover tasks the previous process left mid-flight so they aren't
// stranded. Nothing in this fresh process is driving them yet (the in-memory
// `running` set is empty), so a task can be left in one of these states:
//
//   - a run still in flight: it carries a runId. The daemon (which outlived the
//     server) may still hold the run, or it may have finished while we were down —
//     either way driveTask reattaches and finishes reducing it, uninterrupted.
//     Only if the daemon dropped the run past its reconnect grace was it truly
//     interrupted; that falls through to the replay handling below.
//   - queued messages that never got drained — resume and drain them.
//   - interrupted mid-run with no recoverable run: left "riding" with an empty
//     queue, because driveTask removes the whole queue *before* running the turn,
//     so a restart mid-turn loses the queued entries and the status is never
//     reset. These would otherwise sit "riding" with a stale `pending` message
//     forever.
//
// For the interrupted cases we clear stale `pending` flags and, if nothing is
// queued, re-supply a prompt so driveTask has a turn to run: a "Resumed at …"
// nudge (mirroring launchTask) for one that already replied, or — for one whose
// opening run died before any reply — the original opening message replayed (no
// session exists yet, so it starts fresh). A task with no assistant turn yet
// never established its session — start it; otherwise resume.
async function recoverQueues(): Promise<void> {
  for (const project of PROJECTS) {
    let names: string[]
    try {
      names = await readdir(project.dataDir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      const file = path.join(project.dataDir, name)
      // Revive on read so the interrupted-detection below works uniformly over the
      // v2 item log regardless of the file's on-disk shape (the boot sweep converts
      // the rest of the backlog separately).
      const task = await readTask(project.dataDir, id)
      if (!task) continue
      // A scheduled task waits for its launch time — launchScheduled owns it,
      // not the queue recovery (it carries a queued opening message too).
      if (task.scheduledFor) continue
      const everRan = (task.rides?.length ?? 0) > 0

      // A tracked run: hand it to driveTask, whose reattach asks the daemon to
      // replay from the persisted cursor (or aborts it if the daemon is gone past
      // the grace). The daemon, having outlived our restart, still holds the run
      // and its buffer.
      if (task.runId) {
        void driveTask(project, id)
        continue
      }

      const hasQueue = !!(task.queued && task.queued.length)
      // A turn interrupted by the previous process dying, with nothing driving it
      // now. Under the status collapse an idle (resting) task is stored `riding`
      // too, so "riding" no longer means "mid-run" — the real signal is unfinished
      // work with no live run: a still-open ride, or a trailing user item that
      // never got its reply (its queue was drained before the crash). A tracked run
      // (runId) was handled above; wedged/landed are left alone.
      const lastItem = task.items[task.items.length - 1]
      // A hook's nudge counts as a trailing prompt exactly as a user message
      // does: it was queued, and the queue may have drained before the ride
      // opened. Without it a nudge lost to a restart is never recovered — and
      // this server restarts on every `server/**` edit.
      const trailingPrompt =
        lastItem?.kind === 'message' &&
        (lastItem.role === 'user' || lastItem.role === 'hook')
      const interrupted =
        task.status === 'riding' &&
        !hasQueue &&
        (!!openRide(task) || trailingPrompt)
      if (!hasQueue && !interrupted) continue
      await mutateTask(file, (t) => {
        // Close any ride the dead process left open (the v2 analog of clearing a
        // stale pending flag) so the task doesn't read as live.
        if (openRide(t)) closeRide(t, 'interrupted', new Date().toISOString())
        if (interrupted) {
          if (everRan) {
            const at = new Date().toISOString()
            const text = `Resumed at ${new Date(at).toLocaleString()} after the previous run was interrupted.`
            pushUserItem(t, text, at)
            ;(t.queued ??= []).push(text)
            t.updatedAt = at
          } else {
            // The opening run died before any reply. Replay the original opening
            // prompt (the last user item) without adding a duplicate display item;
            // driveTask runs it as a fresh turn (no sessionId persisted yet, so the
            // daemon mints one).
            // The trailing PROMPT, not the trailing user message: a task whose
            // opening run died can have a hook's nudge as its last prompt, and
            // re-queueing the user message before it would re-run work the task
            // already did while dropping the nudge entirely.
            const opening = promptItems(t).at(-1)
            if (opening) (t.queued ??= []).push(opening.text)
          }
        }
      }).catch(() => {})
      void driveTask(project, id)
    }
  }
}

// One-time backfill of `seenAt` for tasks saved before the field existed: pin it
// to the task's current latest update so they start out caught-up (no unseen
// dot), and only genuinely newer activity lights it. Idempotent — a task that
// already has a marker is left alone, so this is a no-op on every boot after the
// first.
async function backfillSeen(): Promise<void> {
  for (const project of PROJECTS) {
    let names: string[]
    try {
      names = await readdir(project.dataDir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const file = path.join(project.dataDir, name)
      try {
        const task = JSON.parse(await readFile(file, 'utf8')) as Task
        if (task.seenAt !== undefined) continue
        await mutateTask(file, (t) => {
          if (t.seenAt === undefined) t.seenAt = latestUpdateAt(t)
        })
      } catch {
        // skip unreadable/invalid files
      }
    }
  }
}

// One-time backfill of the task provider field introduced before Codex support:
// existing tasks all ran through Claude, so pin them to that provider. Covers
// archived tasks too, matching backfillIds.
async function backfillAgents(): Promise<void> {
  for (const project of PROJECTS) {
    for (const dir of [project.dataDir, project.archiveDir]) {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const file = path.join(dir, name)
        try {
          const task = JSON.parse(await readFile(file, 'utf8')) as Task
          if (task.agent !== undefined) continue
          // A task that names a flow is NOT a legacy task missing its agent —
          // it is one that deliberately has none. Stamping LEGACY_AGENT here
          // would make taskFlow() still read `flow` correctly, but it would
          // resurrect `agent` on every server boot and hand the C6 dispatch
          // path a legal-looking legacy kind for a flow that isn't one.
          if (task.flow !== undefined) continue
          await mutateTask(file, (t) => {
            if (t.agent === undefined && t.flow === undefined)
              t.agent = LEGACY_AGENT
          })
        } catch {
          // skip unreadable/invalid files
        }
      }
    }
  }
}

// One-time migration of the pre-rename `session` field, when a task's only
// identity was its filename (which doubled as `session`) and "awaiting" lifecycle
// events stored their awaited tasks as `{ session, title }`. Two fixes per file:
// give the task an `id` (always its filename stem — legacy tasks keep the uuid
// they were keyed by, new ones already carry their nanoid), and rewrite any
// legacy `awaiting` event entries to `{ id, title }` so the UI's link rendering
// (which now reads `.id`) doesn't choke on an undefined id. Covers archived tasks
// too, since the UI reads those back. Idempotent: a file already in the new shape
// is left untouched.
type LegacyAwait = { id?: string; session?: string; title: string }

async function backfillIds(): Promise<void> {
  for (const project of PROJECTS) {
    for (const dir of [project.dataDir, project.archiveDir]) {
      let names: string[]
      try {
        names = await readdir(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const file = path.join(dir, name)
        const stem = name.slice(0, -'.json'.length)
        try {
          // Revive on read so the awaiting scan runs over v2 event items (the
          // converter carries any legacy `awaiting` verbatim onto them).
          const task = await readTask(dir, stem)
          if (!task) continue
          const legacyAwaits = eventItems(task).some((e) =>
            (e.awaiting as LegacyAwait[] | undefined)?.some(
              (a) => a.id === undefined && a.session !== undefined,
            ),
          )
          if (task.id !== undefined && !legacyAwaits) continue
          await mutateTask(file, (t) => {
            if (t.id === undefined) t.id = stem
            for (const e of eventItems(t)) {
              for (const a of (e.awaiting as LegacyAwait[] | undefined) ?? []) {
                if (a.id === undefined && a.session !== undefined) {
                  a.id = a.session
                  delete a.session
                }
              }
            }
          })
        } catch {
          // skip unreadable/invalid files
        }
      }
    }
  }
}

const port = Number(process.env.PORT ?? 6181)
if (process.env.NODE_ENV !== 'test' && process.env.VITEST !== 'true') {
  const server = serve({ fetch: app.fetch, port })
  console.log(`api listening on http://localhost:${port}`)

  // Accept the host daemon's WebSocket and route runs to it. The server's
  // @hono/node-server serve() returns a Node http.Server, which we hand to the WS
  // layer to handle the /daemon upgrade. The daemon owns usage end to end
  // (decision 6): each pushed snapshot lands straight in the cache the tasks poll
  // embeds and the daemon's connect-time push primes it.
  attachDaemonServer(server as unknown as import('node:http').Server, {
    token: DAEMON_TOKEN,
    // Warn at register time about a slug mismatch between how the daemon was
    // launched and the projects this server serves — the usual silent cause of a
    // task wedging with "daemon does not serve this project". A project we serve
    // that the daemon doesn't is the one that breaks tasks (missing); a slug the
    // daemon serves that we don't is harmless launch-arg drift (extra), logged for
    // symmetry. Both point back at the PROJECT_DIRS the two sides were launched with.
    onRegister: (slugs) => {
      const served = new Set(slugs)
      const configured = new Set(PROJECTS.map((p) => p.slug))
      const missing = PROJECTS.map((p) => p.slug).filter((s) => !served.has(s))
      const extra = slugs.filter((s) => !configured.has(s))
      if (missing.length)
        console.warn(
          `daemon does NOT serve ${missing.length} configured project(s): ` +
            `${missing.join(', ')} — tasks for these will wedge. ` +
            `Launch the daemon with the same project dirs as the server.`,
        )
      if (extra.length)
        console.warn(
          `daemon serves ${extra.length} project(s) this server doesn't: ` +
            `${extra.join(', ')} — launch-arg drift, harmless.`,
        )
    },
    onTelemetry: (agent, items) => {
      telemetryCache.set(agent, items)
    },
  })
  console.log(`daemon WS endpoint at ws://localhost:${port}/daemon`)
  console.log('projects:')
  for (const p of PROJECTS) console.log(`  ${p.slug}  ${p.path}`)
  void backfillIds()
  void backfillAgents()
  void backfillSeen()
  void recoverQueues()
  // Launch due scheduled tasks on boot (catching any whose time passed while the
  // server was down), then sweep every 15s to launch each as it comes due.
  void launchScheduled()
  const scheduler = setInterval(() => void launchScheduled(), 15_000)

  // Shut down cleanly when the watcher restarts us (or on Ctrl-C): stop the
  // scheduler and let the HTTP server finish the requests already in flight
  // before exiting, so a reload doesn't drop a write mid-flight. In-flight runs
  // need no special handling — they live in the daemon, which outlives the
  // server; the fresh process reattaches over the WS and resumes each from the
  // persisted cursor (resume-from). A timeout forces the exit if a connection
  // refuses to close.
  let shuttingDown = false
  function shutdown(): void {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(scheduler)
    const force = setTimeout(() => process.exit(0), 3_000)
    force.unref()
    server.close(() => {
      clearTimeout(force)
      process.exit(0)
    })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
