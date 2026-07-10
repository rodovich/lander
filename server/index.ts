import { Hono } from 'hono'
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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyUpdate, applyDone } from './apply'
import { defaultAgentFromEnv, isAgentKind } from './agent'
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
import type { AgentKind, StartRunMessage, UsageBody } from './protocol'
import {
  readTasks as readTasksStore,
  readTask as readTaskStore,
  writeTask as writeTaskStore,
  mutateTask as mutateTaskStore,
} from './store'
import { parseProjects, type Project } from './projects'
import {
  publicTask,
  latestUpdateAt,
  recordStatusTransition,
  pendingMessage,
  recordArtifactOnMessage,
  lastTurnPrompts,
  turnAttachments,
  worktreeName,
  applyRelaunch,
  applyDueMessages,
  armScheduledRelaunch,
  type Message,
  type TaskEvent,
  type ScheduledMessage,
  type RepeatSpec,
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
  answerAsk,
  answerDelivery,
  chosenOption,
  withdrawOpenAsks,
  validateAskForm,
  nextAskId,
  type Ask,
  type AskForm,
} from './asks'

const execFileAsync = promisify(execFile)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LANDER_BIN_DIR = path.join(ROOT, 'bin')

const PROJECTS = parseProjects(ROOT, process.env, process.cwd())
const PROJECT_BY_SLUG = new Map<string, Project>(
  PROJECTS.map((p) => [p.slug, p]),
)
const LEGACY_AGENT: AgentKind = 'claude'
const DEFAULT_NEW_TASK_AGENT = defaultAgentFromEnv(process.env)
const CODEX_TASK_ALLOW_WARNING =
  'Saved for parity; Codex runs do not honor task allow rules yet'

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
  // The provider used for this task. Stored so future turns resume with the same
  // provider once multiple agents exist. Existing tasks are backfilled to Claude.
  agent: AgentKind
  // The provider session id backing this task's turns, reported by the daemon on
  // the first turn and persisted by the server (see SessionMessage /
  // reduceRunWs). Passed to the daemon each turn so it can resume the same
  // provider session. Decoupled from `id` so a task can later run multiple or
  // fresh sessions. Absent until the first turn reports one.
  sessionId?: string
  title: string
  status: string
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
  messages: Message[]
  // Named output slots this task has published (`lander artifact put`), latest
  // version only — the slot registry, upserted by name. Each points at its
  // current blob in the project's attachmentsDir (shared with input attachments);
  // republishing a name mints a fresh blob and supersedes the old. The generating
  // assistant message also carries a point-in-time ref (Message.artifacts), but
  // this is the source of truth for the current version, and downloads resolve
  // against it by name. Absent on tasks that have published none.
  artifacts?: Artifact[]
  // Lifecycle events (launch, rename, wedged/un-wedged, landed/un-landed),
  // interleaved with messages by timestamp in the UI. Absent on tasks saved
  // before this existed.
  events?: TaskEvent[]
  // Questions raised on this task (`POST /asks`, or the platform's usage-limit/
  // error retry ask), interleaved with messages/events by `createdAt` in the UI
  // exactly like events. A task-blocking ask wedges until answered. Passed
  // through by publicTask (nothing secret in an ask). Absent when none raised.
  asks?: Ask[]
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
  // launches the task. Absent on un-scheduled tasks.
  scheduledFor?: string
  // Task ids this task is resting on (`lander new/rest --await`). The scheduler
  // launches the task once every one has reached terminal "landed" — a missing
  // id (archived/deleted) counts as satisfied so a vanished dependency can't
  // strand the waiter. Coexists with `scheduledFor` as an OR fallback. Cleared
  // on launch, alongside scheduledFor. Absent when not awaiting.
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
    if (task.events?.some((e) => e.kind === 'renamed')) return
    task.title = title
    // Naming succeeded, so a prior failure no longer needs retrying on the next
    // wakeup (see ensureTitle / driveTask).
    delete task.titlePending
    // This is the first generated name for a task created untitled: fill it into
    // the creation event (a launch, or a "scheduled" event for a deferred task)
    // rather than recording it as a rename.
    const created = task.events?.find(
      (e) => e.kind === 'launched' || e.kind === 'scheduled',
    )
    if (created && !created.title) created.title = title
  })
}

// Ask haiku for a short 2-5 word title naming a task. The task text is passed
// as delimited data under a replaced system prompt — not the default agentic
// one — so the model labels the task instead of trying to carry it out (its
// messages are imperatives and read as a dialogue to continue otherwise).
// Returns null when generation fails (the call errored or produced nothing) so
// callers can tell a real name from a non-result — task creation never blocks on
// it, and a transient failure is retried on the task's next wakeup rather than
// being papered over with a permanent placeholder (see ensureTitle).
async function generateTitle(
  projectDir: string,
  message: string,
): Promise<string | null> {
  const system =
    'You name tasks. Given the text of a task, you reply with a short title ' +
    'for it and nothing else. You never carry out, answer, or continue the ' +
    'task — you only label it. Reply with 2-5 words in sentence case, with no ' +
    'quotes and no trailing punctuation.'
  const prompt = `Title this task:\n\n<task>\n${message}\n</task>`
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['--model', 'haiku', '--system-prompt', system, '-p', prompt],
      { cwd: projectDir, maxBuffer: 1024 * 1024, timeout: 60_000 },
    )
    const title = stdout.trim().replace(/^["']+|["'.]+$/g, '').trim()
    return title || null
  } catch {
    return null
  }
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
    if (!t.events?.some((e) => e.kind === 'renamed')) t.titlePending = true
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
  attachments: Attachment[] = [],
): Promise<'done' | 'crashed'> {
  const file = path.join(project.dataDir, `${id}.json`)
  let task: Task
  try {
    task = JSON.parse(await readFile(file, 'utf8')) as Task
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await mutateTask(file, (t) => {
      const msg = pendingMessage(t)
      if (msg) {
        msg.text = `error running assistant: ${message}`
        msg.pending = false
      } else {
        t.messages.push({
          role: 'assistant',
          text: `error running assistant: ${message}`,
          createdAt: new Date().toISOString(),
        })
      }
    }).catch(() => {})
    return 'crashed'
  }

  // The token the in-task `lander` CLI sends back to authenticate as this task.
  // Backfilled for tasks created before tokens existed.
  const token = task.token ?? randomUUID()
  const agent = task.agent ?? LEGACY_AGENT
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

  const runId = randomUUID()

  // Wait briefly for a daemon serving this project to be connected (dev launches
  // it with the server, so it's normally already up); if none arrives, wedge the
  // turn with an error rather than hang.
  if (!(await awaitDaemonServing(project.slug))) {
    await mutateTask(file, (t) => {
      const at = new Date().toISOString()
      const msg = pendingMessage(t)
      // Distinguish the two ways this fails: no daemon at all vs. a daemon that
      // is connected but doesn't serve this project's slug (a path/slug mismatch
      // between how the daemon was launched and how the task is keyed). The
      // latter is otherwise indistinguishable and the usual silent culprit, so
      // name the slug we wanted and the slugs the daemon actually serves.
      const text = daemonConnected()
        ? `error running assistant: a daemon is connected but does not serve this project (slug '${project.slug}'); daemon serves: ${daemonSlugs().join(', ') || '(none)'}`
        : 'error running assistant: no daemon connected for this project'
      if (msg) {
        msg.text = text
        msg.pending = false
      } else {
        t.messages.push({ role: 'assistant', text, createdAt: at })
      }
      recordStatusTransition(t, 'wedged', at)
      t.status = 'wedged'
      t.updatedAt = at
      // The turn never reached the agent, so nothing was committed — stash the
      // prompt(s) so the user can just retry once a daemon is back (a transient
      // daemon outage is the expected cause).
      t.retry = { committed: false, prompts: lastTurnPrompts(t.messages) }
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
    // A new turn supersedes any pending retry from the last failed one.
    delete t.retry
  })

  const start: StartRunMessage = {
    type: 'start-run',
    runId,
    taskId: id,
    agent,
    project: project.slug,
    // cwd hints — the daemon does the stat/fallback/worktree resolution locally.
    recordedCwd: task.cwd,
    prompt,
    task: {
      allowEdits: task.allowEdits,
      allow: task.allow,
      worktree: task.worktree,
    },
    // The provider session to resume; absent on the first turn, so the daemon
    // reports one back (reduceRunWs persists it onto task.sessionId).
    sessionId: task.sessionId,
    // The context baseline rides only with a session to resume: a fresh session
    // (first turn, or post-relaunch) must always receive the full block.
    turnContext: task.sessionId ? task.turnContext : undefined,
    // This turn's attachment refs; the daemon materializes them and builds the
    // prompt manifest. Omitted when the turn carries none.
    attachments: attachments.length ? attachments : undefined,
    env: landerEnv,
    idleTimeoutMs: 10 * 60_000,
  }
  sendToDaemon(start)
  return reduceRunWs(project, id, runId)
}

// Drain the per-run channel the WS handler feeds (update/done/crashed) and fold
// each event onto the task with the applyUpdate/applyDone consumer. The daemon
// did the reduction and the cross-line usage accumulation, so an `update` maps
// straight onto applyUpdate (seq becomes the run cursor); `done` finalizes;
// `crashed` (the daemon stayed gone past the reconnect grace) finalizes the task
// as an interrupted run. Returns 'done' on completion (success or assistant error)
// or 'crashed'. `resume` reattaches to a run already in flight (a server
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
          const msg = pendingMessage(t)
          if (msg) {
            if (!msg.text) msg.text = 'error running assistant: run interrupted'
            msg.pending = false
            t.updatedAt = new Date().toISOString()
          }
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
          if (!t.sessionId) t.sessionId = ev.msg.sessionId
        }).catch(() => {})
        continue
      }
      if (ev.kind === 'turn-context') {
        // The daemon appended a fresh dynamic context block to this turn's
        // prompt; record it as the baseline the next turn's block is compared
        // against. Idempotent: a resume-from replay re-sends the same block.
        await mutateTask(file, (t) => {
          t.turnContext = ev.msg.context
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
          applyDone(t, ev.msg, { rateLimitResetsAt, at })
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
      const opening = existing.messages.find((m) => m.role === 'user')?.text
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
      let batch: string[] = []
      let atts: Attachment[] = []
      await mutateTask(file, (t) => {
        if (t.queued && t.queued.length) {
          batch = t.queued
          // Gather the attachments off the trailing user messages this batch is
          // made of, under the same lock, so the run carries exactly this turn's
          // files (see turnAttachments).
          atts = turnAttachments(t.messages, batch.length)
          delete t.queued
        }
      }).catch(() => {})
      if (!batch.length) break
      await runTurn(project, id, batch.join('\n\n'), atts)
    }
  } finally {
    running.delete(id)
    // Only come to rest if no run is tracked. Our own turn cleared its runId when
    // it finished (the reducer deletes it on done/crash), so a runId here belongs
    // to a *newer* drainer that re-rode this task after we left the running set —
    // demoting it would strand that live run at "resting" for its whole duration.
    await mutateTask(file, (t) => {
      if (t.status === 'riding' && !t.runId) t.status = 'resting'
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
async function launchTask(project: Project, id: string): Promise<boolean> {
  const file = path.join(project.dataDir, `${id}.json`)
  let go = false
  let everRan = false
  await mutateTask(file, (t) => {
    // Launch on either pending trigger (a scheduled time or an await condition);
    // the scheduler only calls us once one has fired. Clear both so the OR
    // fallback doesn't re-fire the task after it's running.
    if ((!t.scheduledFor && !t.waitingFor) || running.has(id)) return
    everRan = t.messages.some((m) => m.role === 'assistant')
    delete t.scheduledFor
    delete t.waitingFor
    const at = new Date().toISOString()
    // A task that scheduled a session-limit retry stayed wedged until now (see
    // the /retry handler), so record the un-wedge a hair ahead of the launch —
    // it surfaces in the timeline before the queued recovery prompt that the
    // wakeup is about to drive. A no-op for a merely-resting scheduled task.
    recordStatusTransition(t, 'riding', new Date(Date.parse(at) - 1).toISOString())
    ;(t.events ??= []).push({ kind: 'launched', title: t.title, createdAt: at })
    t.status = 'riding'
    t.updatedAt = at
    // A task put to rest with `lander rest` has already run its opening turn, so
    // nothing is queued to wake it — give the agent a prompt announcing it's
    // back. A task scheduled at creation (`new --date`) still has its opening
    // message queued and drives that instead, so skip the synthetic prompt.
    if (everRan && !(t.queued && t.queued.length)) {
      const text = `Resumed at ${new Date(at).toLocaleString()}.`
      t.messages.push({ role: 'user', text, createdAt: at })
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
    recordStatusTransition(t, 'riding', new Date(Date.parse(at) - 1).toISOString())
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
async function launchScheduled(): Promise<void> {
  const now = Date.now()
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
      // Then launch a deferred task whose trigger has fired.
      if (running.has(id)) continue
      const timeDue =
        task.scheduledFor != null && Date.parse(task.scheduledFor) <= now
      const awaitDue =
        (task.waitingFor?.length ?? 0) > 0 &&
        (await awaitSatisfied(project, task.waitingFor!))
      if (timeDue || awaitDue) await launchTask(project, id)
    }
  }
}

// The latest usage snapshot the daemon pushed (decision 6). The daemon owns the
// fetch + refresh schedule and sends a `usage` message on each refresh, which
// lands here via the WS handler; the server only caches it and serves it (the
// tasks poll embeds it, /api/usage returns it). The server never reads the
// credential or hits the OAuth endpoint, which is what lets it move into a
// credential-less container later.
let usageCache: { at: number; body: UsageBody } | null = null

// The shared secret that marks a request as coming from the human's browser
// (vs. a task's `lander` CLI). Prefer the env var dev.mjs sets — it hands the
// same value to Vite so the client can send it — and fall back to a persisted
// file so a manual API restart keeps the value the running browser already
// holds. Generated on first use. Tasks don't get this in their env; a fully
// adversarial task on the same machine could still read the file, which is
// inherent to running untrusted agents as the same user.
async function loadUiToken(): Promise<string> {
  const fromEnv = process.env.LANDER_UI_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const file = path.join(ROOT, 'data', '.ui-token')
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

export const app = new Hono()

// Current Claude subscription usage: the 5-hour session window and the 7-day
// weekly window, each as { utilization (0-100), resetsAt }. Mirrors what the
// `/usage` command in the Claude CLI shows. Served from the snapshot the daemon
// pushes (decision 6) — the same cache the tasks poll embeds; the server never
// fetches it. 503 until the daemon's first push lands.
app.get('/api/usage', (c) => {
  if (!usageCache)
    return c.json({ error: 'no usage snapshot available yet' }, 503)
  return c.json(usageCache.body)
})

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
    // Account usage rides along with every tasks poll so the client never has to
    // decide when it's stale (the daemon refreshes and pushes it — decision 6).
    // It's global, not per-project — the same snapshot on every project's response.
    const usage = usageCache?.body ?? null
    if (c.req.query('archived') !== '1')
      return c.json({
        tasks: (await readTasks(project.dataDir)).map(publicTask),
        usage,
      })
    const archived = (await readTasks(project.archiveDir)).map((t) => ({
      ...t,
      archived: true,
    }))
    archived.sort((a, b) =>
      (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
    )
    return c.json({ tasks: archived.map(publicTask), usage })
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
  if (!task) return c.json({ error: 'task not found' }, 404)
  return c.json(publicTask(task))
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
      allowEdits?: unknown
      attachments?: unknown
    }>()
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const rawMessage = typeof body.message === 'string' ? body.message : ''
    const agent = isAgentKind(body.agent) ? body.agent : DEFAULT_NEW_TASK_AGENT
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
    // The creation event, timestamped a hair before the opening message so the
    // timeline shows it ahead of that message. A task awaiting other tasks gets
    // an "awaiting" event (carrying them, for links) even if it also has a time
    // fallback — the condition is what's shown; a purely time-deferred task gets
    // "scheduled"; an immediate task gets "launched". The matching "launched"
    // event is recorded later, when it actually runs.
    const createdEvent: TaskEvent = {
      kind: !deferred ? 'launched' : waitingFor ? 'awaiting' : 'scheduled',
      title: title || undefined,
      ...(deferred && waitingFor
        ? { awaiting: await describeAwaited(project, waitingFor) }
        : deferred && scheduledFor
          ? { scheduledFor }
          : {}),
      createdAt: new Date(Date.parse(now) - 1).toISOString(),
    }
    const task: Task = {
      id,
      agent,
      title: title || '…',
      // A deferred task rests until the scheduler launches it at scheduledFor.
      // Otherwise "riding" while the agent works on the opening message (driveTask
      // flips it to "resting" when it returns), or "wedged" with no message —
      // it needs the user to supply a first prompt.
      status: deferred ? 'resting' : message.trim() ? 'riding' : 'wedged',
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
      messages: [
        {
          role: 'user',
          text: message,
          createdAt: now,
          ...(attachments ? { attachments } : {}),
        },
      ],
      events: [createdEvent],
      // The opening message rides the same queue as follow-ups; driveTask
      // drains it (immediately, or when the scheduler launches a deferred task).
      // It stays in `messages` above for display.
      queued: message.trim() ? [message] : [],
      // Both triggers persist when deferred; the scheduler fires on whichever
      // comes first. Omitted entirely on an immediate task.
      ...(deferred && scheduledFor ? { scheduledFor } : {}),
      ...(deferred && waitingFor ? { waitingFor } : {}),
    }

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
    }>()

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
          (t.events ??= []).push({
            kind: 'renamed',
            title: next,
            createdAt: new Date().toISOString(),
          })
          t.updatedAt = new Date().toISOString()
        }
        t.title = next
      }
      if (typeof body.allowEdits === 'boolean') t.allowEdits = body.allowEdits
      if (typeof body.status === 'string') {
        const at = new Date().toISOString()
        recordStatusTransition(t, body.status, at)
        if (body.status !== t.status) t.updatedAt = at
        t.status = body.status
        // Moving off wedged (a manual land/resume) supersedes any open ask; a
        // fresh wedge keeps it. (When not previously wedged there's no open
        // task-blocking ask to touch, so this only bites the intended case.)
        if (body.status !== 'wedged') withdrawOpenAsks(t)
      }
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
    const launched = await launchTask(project, id)
    if (!launched)
      return c.json({ error: 'task is not scheduled' }, 409)
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
      // Record leaving any notable status (wedged/landed); resting itself is a
      // quiet status, so this is usually a no-op for the riding agent.
      recordStatusTransition(t, 'resting', at)
      // Replace any prior triggers so re-resting doesn't leave a stale one armed.
      if (scheduledFor) t.scheduledFor = scheduledFor
      else delete t.scheduledFor
      if (waitingFor) t.waitingFor = waitingFor
      else delete t.waitingFor
      // An await condition is what's shown (with its links) even alongside a time
      // fallback; a pure time rest keeps the scheduled event.
      ;(t.events ??= []).push(
        waitingFor
          ? { kind: 'awaiting', title: t.title, awaiting, createdAt: at }
          : { kind: 'scheduled', title: t.title, scheduledFor, createdAt: at },
      )
      t.status = 'resting'
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
      applyRelaunch(t, rawMessage, at, repeat)
      // The relaunch is the user's new intent; withdraw any open ask it
      // supersedes (parity with the retry it already drops in applyRelaunch).
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
    if (archived && (task.status === 'riding' || task.runId))
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

    let task: Task
    try {
      task = JSON.parse(await readFile(file, 'utf8')) as Task
    } catch {
      return c.json({ error: 'task not found' }, 404)
    }

    // Title from the user's own messages only. The goal lives in what the user
    // asked for; the assistant's replies are execution detail that dominates the
    // transcript by volume and pulls titles off-goal and over-length.
    const goal = task.messages
      .filter((m) => m.role === 'user')
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
        (t.events ??= []).push({
          kind: 'renamed',
          title: next,
          createdAt: new Date().toISOString(),
        })
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
    }>()
    const rawMessage = typeof body.message === 'string' ? body.message : ''
    if (!rawMessage.trim()) return c.json({ error: 'message is required' }, 400)

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
      recordStatusTransition(t, 'riding', new Date(Date.parse(now) - 1).toISOString())
      t.messages.push({
        role: 'user',
        text: message,
        createdAt: now,
        ...(attachments ? { attachments } : {}),
      })
      t.updatedAt = now
      // Queue the prompt for the session and go "riding". driveTask clears it to
      // "resting" once the queue drains.
      t.queued = [...(t.queued ?? []), message]
      t.status = 'riding'
      // A fresh message is the user's new intent; drop any pending retry so its
      // button doesn't linger over the revived conversation, and withdraw any
      // open ask the message supersedes.
      delete t.retry
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
// task until it's answered. Principal: the task itself (posting its own ask
// mid-turn — self-initiated, so no run interrupt, exactly like `lander wedge`)
// or the UI (mirror the artifact-publish gate). v1 implements only
// `blocking: 'task'`; `ride`/`none` ship in the vocabulary but 400 here until
// their behavior exists.
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
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) return c.json({ error: 'prompt is required' }, 400)
    const formError = validateAskForm(body.form)
    if (formError) return c.json({ error: formError }, 400)
    const form = body.form as AskForm
    // Only task-blocking asks are reachable in v1: ride-blocking (long-poll) and
    // advisory asks aren't implemented, so reject rather than store a shape whose
    // behavior doesn't exist yet.
    const blocking = body.blocking ?? 'task'
    if (blocking !== 'task')
      return c.json(
        { error: `blocking: '${blocking}' is not implemented yet` },
        400,
      )

    let created: Ask | undefined
    await mutateTask(file, (t) => {
      const at = new Date().toISOString()
      const askId = nextAskId(t, Date.now())
      // A task-blocking ask wedges the task in the same write, recording the
      // crossing so it surfaces in the timeline (decision 2). driveTask's finally
      // only demotes riding→resting, so a wedge set here survives a self-post.
      recordStatusTransition(t, 'wedged', at)
      t.status = 'wedged'
      t.updatedAt = at
      created = createAsk(t, { id: askId, prompt, form, blocking: 'task', at })
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
      const ask = res.ask
      const opt = chosenOption(ask)
      const scheduleAt = opt?.at
      defer = !!scheduleAt && Date.parse(scheduleAt) > Date.now()
      // Deliver the answer as a visible user message so it appears in the
      // re-entry prompt. Null for an origin:'retry' ask — the retry recovery is
      // its delivery (recast); a plain answer's text is queued for the session.
      const delivery = answerDelivery(ask)
      if (delivery != null) {
        t.messages.push({ role: 'user', text: delivery, createdAt: now })
        t.queued = [...(t.queued ?? []), delivery]
      }
      if (defer && scheduleAt) {
        // Scheduling is not an un-wedge: stay wedged (the moon shows via
        // scheduledFor) until launchTask fires the wakeup and drains the
        // queued delivery — mirrors the deferred retry exactly.
        t.scheduledFor = scheduleAt
        ;(t.events ??= []).push({
          kind: 'scheduled',
          title: t.title,
          scheduledFor: scheduleAt,
          createdAt: now,
        })
      } else {
        recordStatusTransition(t, 'riding', before)
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

// Retry a turn that wedged on an assistant error (500/429/etc). The recovery depends
// on whether the failed turn's prompt reached the session (recorded as
// `retry.committed` when the run wedged): if it did, re-sending it would
// duplicate the user turn in the provider transcript, so we nudge the session to
// pick the orphaned turn back up with a minimal "try again". If it didn't, the
// prompt(s) never landed — re-send them. They're already in messages[] from the
// original send, so the re-send only re-queues (no duplicate visible message);
// the nudge does append a "try again" user message so the conversation reads.
//
// When the wedge was a session-limit rejection whose reset time is still in the
// future (`retry.resetsAt`), retrying now would just hit the same wall — so
// instead of driving immediately we queue the recovery turn and rest the task
// with `scheduledFor` at the reset time. The scheduler then relaunches it via
// launchTask, draining the queued prompt(s), exactly as a `lander rest --date`
// wakeup does.
app.post('/api/:project/tasks/:id/retry', async (c) => {
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

    // Retrying re-drives the session, so it's the human's call: only the UI may
    // do it, mirroring the other status-changing actions.
    if ((await resolvePrincipal(c.req)).kind !== 'ui')
      return c.json({ error: 'not authorized to retry' }, 403)

    if (!task.retry) return c.json({ error: 'nothing to retry' }, 400)

    const now = new Date().toISOString()
    // A session-limit wedge whose limit hasn't lifted yet schedules the retry for
    // its reset time rather than driving now; a past (or absent) reset retries
    // immediately, as before.
    const resetsAt = task.retry.resetsAt
    const defer = !!resetsAt && Date.parse(resetsAt) > Date.now()
    // For an immediate retry, record the un-wedge a hair before the action's own
    // timestamp so the timeline shows it ahead of what follows, exactly as a
    // follow-up message does. A deferred retry stays wedged (see below), so this
    // is unused there.
    const before = new Date(Date.parse(now) - 1).toISOString()
    await mutateTask(file, (t) => {
      if (!t.retry) return
      // Queue the recovery turn either way — the only difference is when it runs.
      const resend = t.retry.prompts.filter((p) => p.trim())
      if (t.retry.committed || !resend.length) {
        // Committed (or nothing concrete to re-send): nudge the session forward.
        const text = 'try again'
        t.messages.push({ role: 'user', text, createdAt: now })
        t.queued = [...(t.queued ?? []), text]
      } else {
        // Not committed: re-send the un-received prompt(s). Already in messages[]
        // from the original send, so only re-queue them for the session.
        t.queued = [...(t.queued ?? []), ...resend]
      }
      if (defer && resetsAt) {
        // Scheduling a retry is not an un-wedge: the task stays wedged until the
        // limit actually lifts, so the user keeps seeing it as needing them (and
        // the sidebar shows the moon, driven by scheduledFor below). We record
        // only a 'scheduled' event to mark the wait in the timeline; the un-wedge
        // is deferred to launchTask, which records it when the wakeup fires —
        // just before it drains the queued prompt(s), exactly as if the user had
        // waited until the reset time and sent "try again" themselves.
        // recoverQueues skips scheduledFor tasks, so the queued prompt(s) sit
        // untouched until launchScheduled fires launchTask at resetsAt.
        t.scheduledFor = resetsAt
        ;(t.events ??= []).push({
          kind: 'scheduled',
          title: t.title,
          scheduledFor: resetsAt,
          createdAt: now,
        })
        // status stays 'wedged' — deliberately left unchanged.
      } else {
        // Revive and drive now.
        recordStatusTransition(t, 'riding', before)
        t.status = 'riding'
      }
      t.updatedAt = now
      delete t.retry
    })

    // Drive now only for an immediate retry; a deferred one waits for the
    // scheduler. Resume the session if no run is already in flight (mirrors
    // /messages).
    if (!defer && !running.has(id)) void driveTask(project, id)

    const updated = await readTask(project.dataDir, id)
    return c.json(publicTask(updated ?? task))
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
    const grantAgent = task.agent ?? LEGACY_AGENT

    let warning: string | undefined
    if (scope === 'project') {
      const result = await requestProjectGrant({
        project: project.slug,
        agent: grantAgent,
        rule,
      })
      if (!result.ok)
        return c.json(
          { error: result.error ?? 'project grant failed' },
          (result.status ?? 500) as ContentfulStatusCode,
        )
    } else {
      try {
        await mutateTask(file, (t) => {
          const allow = (t.allow ??= [])
          if (!allow.includes(rule)) allow.push(rule)
        })
      } catch {
        return c.json({ error: 'task not found' }, 404)
      }
      if (grantAgent === 'codex') warning = CODEX_TASK_ALLOW_WARNING
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
      let task: Task
      try {
        task = JSON.parse(await readFile(file, 'utf8')) as Task
      } catch {
        continue
      }
      // A scheduled task waits for its launch time — launchScheduled owns it,
      // not the queue recovery (it carries a queued opening message too).
      if (task.scheduledFor) continue
      const everRan = task.messages.some((m) => m.role === 'assistant')

      // A tracked run: hand it to driveTask, whose reattach asks the daemon to
      // replay from the persisted cursor (or aborts it if the daemon is gone past
      // the grace). The daemon, having outlived our restart, still holds the run
      // and its buffer.
      if (task.runId) {
        void driveTask(project, id)
        continue
      }

      const hasQueue = !!(task.queued && task.queued.length)
      // "riding" at boot with no live run is a turn interrupted by the previous
      // process dying, since nothing is driving it now.
      const interrupted = task.status === 'riding' && !hasQueue
      if (!hasQueue && !interrupted) continue
      await mutateTask(file, (t) => {
        for (const m of t.messages) if (m.pending) m.pending = false
        if (interrupted) {
          if (everRan) {
            const at = new Date().toISOString()
            const text = `Resumed at ${new Date(at).toLocaleString()} after the previous run was interrupted.`
            t.messages.push({ role: 'user', text, createdAt: at })
            ;(t.queued ??= []).push(text)
            t.updatedAt = at
          } else {
            // The opening run died before any reply. Replay the original opening
            // prompt (the last/only user message) without adding a duplicate
            // display message; driveTask runs it as a fresh turn (no sessionId
            // persisted yet, so the daemon mints one).
            const opening = [...t.messages]
              .reverse()
              .find((m) => m.role === 'user')
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
          await mutateTask(file, (t) => {
            if (t.agent === undefined) t.agent = LEGACY_AGENT
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
          const task = JSON.parse(await readFile(file, 'utf8')) as Task
          const legacyAwaits = (task.events ?? []).some((e) =>
            (e.awaiting as LegacyAwait[] | undefined)?.some(
              (a) => a.id === undefined && a.session !== undefined,
            ),
          )
          if (task.id !== undefined && !legacyAwaits) continue
          await mutateTask(file, (t) => {
            if (t.id === undefined) t.id = stem
            for (const e of t.events ?? []) {
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
    onUsage: (body) => {
      usageCache = { at: Date.now(), body }
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
