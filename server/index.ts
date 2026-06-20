import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { randomUUID } from 'node:crypto'
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  rename,
  open,
  stat,
} from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Namespace each project's tasks under ./data/<normalized-project-path>/tasks.
// e.g. /Users/me/code/myapp -> ./data/Users-me-code-myapp/tasks
function normalizeProjectPath(p: string): string {
  const slug = path
    .resolve(p)
    .replace(/[/\\]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'default'
}

// URL-facing identifier for a project, e.g. /Users/me/code/myapp ->
// "users-me-code-myapp". Lowercased so it reads cleanly in the address bar; the
// on-disk data dir keeps the cased form from normalizeProjectPath above.
function projectSlug(p: string): string {
  return normalizeProjectPath(p).toLowerCase()
}

type Project = {
  path: string
  slug: string
  dataDir: string
  // Sibling of dataDir: ./data/<normalized-project-path>/runs, holding one
  // <runId>/ directory per turn (job spec, append-only output log, lease, done
  // marker). The runner writes these; the server only reads them.
  runsDir: string
  // Sibling of dataDir: ./data/<normalized-project-path>/archived, holding the
  // <uuid>.json files of archived tasks. Moving a task here takes it out of the
  // list (and out of the scheduler's and recovery's view, which only scan
  // dataDir); the UI's "Show archived" toggle reads it back in.
  archiveDir: string
}

// Projects come in newline-separated via PROJECT_DIRS (set by dev.mjs from the
// command-line args), falling back to the legacy single PROJECT_DIR, then cwd.
// Duplicate paths are dropped; the first survivor is the default.
function parseProjects(): Project[] {
  const raw =
    process.env.PROJECT_DIRS ?? process.env.PROJECT_DIR ?? process.cwd()
  const paths = raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const seen = new Set<string>()
  const projects: Project[] = []
  for (const p of paths.length ? paths : [process.cwd()]) {
    const resolved = path.resolve(p)
    const slug = projectSlug(resolved)
    if (seen.has(slug)) continue
    seen.add(slug)
    projects.push({
      path: resolved,
      slug,
      dataDir: path.join(ROOT, 'data', normalizeProjectPath(resolved), 'tasks'),
      runsDir: path.join(ROOT, 'data', normalizeProjectPath(resolved), 'runs'),
      archiveDir: path.join(
        ROOT,
        'data',
        normalizeProjectPath(resolved),
        'archived',
      ),
    })
  }
  return projects
}

const PROJECTS = parseProjects()
const PROJECT_BY_SLUG = new Map<string, Project>(
  PROJECTS.map((p) => [p.slug, p]),
)

// One unit of streamed assistant activity. `text` blocks carry the model's
// prose; `tool_use` records a tool call (name + a compact input summary);
// `tool_result` keeps a truncated peek at what came back. Steps accumulate on
// the in-flight assistant message as claude's stream-json output arrives.
type Step = {
  kind: 'text' | 'tool_use' | 'tool_result'
  text?: string
  tool?: string
  input?: string
  // The tool call's id, carried on both the tool_use step and its matching
  // tool_result step so the UI can pair a call with its outcome.
  toolUseId?: string
  // tool_use only: the call rendered as a settings.json permission string
  // (e.g. `Bash(npm run build)`), used to seed the "allow" popup.
  rule?: string
  // tool_use only, for the file-writing tools (Edit/Write/MultiEdit): the change
  // as before/after hunks, so the UI can reveal a diff under the chip. One hunk
  // per edit (MultiEdit has several); Write has a single hunk with empty `old`.
  // Absent for every other tool.
  edits?: { old: string; new: string }[]
  // tool_result only: whether the call errored, and whether that error was a
  // permission refusal (vs. the tool running and failing for some other reason).
  isError?: boolean
  blocked?: boolean
  createdAt: string
}

type Message = {
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  // Present on assistant turns that were streamed: the live activity trace.
  steps?: Step[]
  // True while claude is still producing this message; cleared when it lands.
  pending?: boolean
}

// A noteworthy point in a task's life, shown inline in the conversation
// timeline: its creation ("launched"), a rename, or a crossing into/out of the
// "wedged" (needs the user) or terminal "landed" status. The quiet riding↔
// resting churn during and after a run isn't interesting, so it isn't recorded.
// Each event captures the task's title as of that moment so a later rename
// doesn't change how earlier events read.
type TaskEvent = {
  kind:
    | 'launched'
    | 'scheduled'
    | 'awaiting'
    | 'wedged'
    | 'unwedged'
    | 'landed'
    | 'unlanded'
    | 'renamed'
  // The task's title at the time of the event. Absent on a launch/schedule event
  // until the first generated name amends it, and on events saved before titles
  // were captured.
  title?: string
  // 'scheduled' only: the date/time the task is set to launch, shown beside the
  // verb (the event's own createdAt is when it was scheduled).
  scheduledFor?: string
  // 'awaiting' only: the tasks this one is resting on (id + title as of the
  // event) so the UI can render them as links. A task awaiting tasks may also
  // carry a --date/--time fallback, but we don't surface that here — the
  // condition is the point.
  awaiting?: { session: string; title: string }[]
  createdAt: string
}

type Task = {
  session: string
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
  allowCommits: boolean
  // Per-task secret minted at creation and injected into the agent's process as
  // LANDER_TOKEN. The `lander` CLI sends it back as the X-Lander-Token header so
  // the server can authenticate which task made a request — used to cap the
  // permissions a task may grant to one it spawns to its own. Never returned
  // over HTTP (see publicTask), so one task can't read another's token. Absent
  // on tasks saved before this field existed; backfilled on the next run.
  token?: string
  // Extra permission rules granted from the UI's "allow in task" action; passed
  // to claude as --allowedTools on every future turn for this task. Absent on
  // tasks saved before this field existed — treat undefined as empty.
  allow?: string[]
  messages: Message[]
  // Lifecycle events (launch, rename, wedged/un-wedged, landed/un-landed),
  // interleaved with messages by timestamp in the UI. Absent on tasks saved
  // before this existed.
  events?: TaskEvent[]
  // Follow-up prompts sent while a run was in flight, awaiting their turn.
  // Persisted so they survive a server restart; drained one turn at a time by
  // driveTask when the current run finishes. Absent on tasks saved before this
  // field existed — treat undefined as empty.
  queued?: string[]
  // Messages addressed to this task with a deferred delivery, sent by another
  // task via `lander send --date/--time/--await`. Each fires when its trigger is
  // met — a time (`deliverAt`) and/or a condition (`waitFor`, ids that must all
  // land), whichever comes first when both are set. The scheduler then appends
  // it as a user message, queues it, and drives the task, exactly as an immediate
  // send would, then drops it. The text already carries its sender backlink.
  // Absent when none are pending.
  scheduledMessages?: {
    text: string
    deliverAt?: string
    waitFor?: string[]
  }[]
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
  // The id of the run (under the project's runs dir) currently being reduced
  // onto this task, and how many bytes of that run's output log have already
  // been folded in. Set when a turn's runner is launched, cleared when its
  // output is fully reduced. Because the runner is a detached process that
  // outlives this server, these let a fresh process reattach to a still-live run
  // and resume reducing exactly where it left off. Internal — stripped from the
  // public task (see publicTask). Absent when no run is in flight.
  runId?: string
  runCursor?: number
}

async function readTasks(dataDir: string): Promise<Task[]> {
  let names: string[]
  try {
    names = await readdir(dataDir)
  } catch {
    return []
  }
  const tasks: Task[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readFile(path.join(dataDir, name), 'utf8')
      tasks.push(JSON.parse(raw) as Task)
    } catch {
      // skip unreadable/invalid files
    }
  }
  tasks.sort((a, b) =>
    (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
  )
  return tasks
}

// Read a single task by id, or null if it's missing/unreadable.
async function readTask(dataDir: string, id: string): Promise<Task | null> {
  try {
    const raw = await readFile(path.join(dataDir, `${id}.json`), 'utf8')
    return JSON.parse(raw) as Task
  } catch {
    return null
  }
}

// Strip the secret `token` before sending a task over HTTP, so the UI (and any
// task scraping the API) can't read another task's token and impersonate it.
function publicTask(
  task: Task,
): Omit<Task, 'token' | 'runId' | 'runCursor'> {
  const { token: _token, runId: _runId, runCursor: _runCursor, ...rest } = task
  return rest
}

// The timestamp of a task's most recent *completed* update: the newest of its
// finished messages (the in-flight, still-streaming one is skipped) and its
// lifecycle events. Mirrors the client's helper of the same name; used to seed
// `seenAt` for tasks that predate the field. ISO timestamps compare
// lexicographically, so the string max is a chronological max.
function latestUpdateAt(task: Task): string {
  let latest = ''
  for (const m of task.messages) {
    if (m.pending) continue
    if (m.createdAt > latest) latest = m.createdAt
  }
  for (const e of task.events ?? []) {
    if (e.createdAt > latest) latest = e.createdAt
  }
  return latest
}

async function setTitle(
  dataDir: string,
  id: string,
  title: string,
): Promise<void> {
  const file = path.join(dataDir, `${id}.json`)
  const task = JSON.parse(await readFile(file, 'utf8')) as Task
  task.title = title
  // This is the first generated name for a task created untitled: fill it into
  // the creation event (a launch, or a "scheduled" event for a deferred task)
  // rather than recording it as a rename.
  const created = task.events?.find(
    (e) => e.kind === 'launched' || e.kind === 'scheduled',
  )
  if (created && !created.title) created.title = title
  await writeFile(file, JSON.stringify(task, null, 2))
}

// Ask haiku for a short 2-5 word title summarizing the task's first message.
// Falls back to a default if generation fails so task creation never blocks.
async function generateTitle(
  projectDir: string,
  message: string,
): Promise<string> {
  const prompt =
    'Generate a concise 2-5 word title summarizing the following task. ' +
    'Use sentence case. ' +
    'Respond with only the title — no quotes, no trailing punctuation.\n\n' +
    message
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['--model', 'haiku', '-p', prompt],
      { cwd: projectDir, maxBuffer: 1024 * 1024, timeout: 60_000 },
    )
    const title = stdout.trim().replace(/^["']+|["'.]+$/g, '').trim()
    return title || 'Untitled task'
  } catch {
    return 'Untitled task'
  }
}

// Atomically replace a task file: write a temp file then rename over the target
// (rename is atomic on the same filesystem). The streaming path rewrites the
// file on every event, so this keeps the 2s poll from ever reading a half-
// written file mid-update.
async function writeTask(file: string, task: Task): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  await writeFile(tmp, JSON.stringify(task, null, 2))
  await rename(tmp, file)
}

// Read-modify-write a task under a single fresh read, so a streaming update
// never clobbers a concurrent edit to another field (title, status, allow
// flags) made via the HTTP endpoints while claude is running.
async function mutateTask(
  file: string,
  fn: (task: Task) => void,
): Promise<void> {
  const task = JSON.parse(await readFile(file, 'utf8')) as Task
  fn(task)
  await writeTask(file, task)
}

// Record a crossing into or out of a "notable" status — "wedged" (the task
// needs the user) or the terminal "landed" — as a timeline event, so the UI can
// show it inline among the messages. Entering a notable status records it
// ("wedged"/"landed"); leaving one for an un-notable status (riding/resting)
// records the inverse ("unwedged"/"unlanded"). A no-op for moves between two
// quiet statuses (e.g. riding↔resting) or that don't change status. Moving
// straight between two notable statuses (wedged↔landed) records the arrival
// only. Call before assigning the new status, while task.status holds the old.
function recordStatusTransition(task: Task, next: string, at: string): void {
  const prev = task.status
  if (prev === next) return
  const events = (task.events ??= [])
  if (next === 'wedged' || next === 'landed')
    events.push({ kind: next, title: task.title, createdAt: at })
  else if (prev === 'wedged' || prev === 'landed')
    events.push({
      kind: prev === 'wedged' ? 'unwedged' : 'unlanded',
      title: task.title,
      createdAt: at,
    })
}

// Boil a tool call's input down to one line for the activity trace: prefer the
// field that best identifies what it's doing (a path, command, pattern…), and
// fall back to compact JSON. Truncated so a giant input can't bloat the file.
function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const v =
    str('file_path') ||
    str('path') ||
    str('command') ||
    str('pattern') ||
    str('query') ||
    str('url') ||
    str('description') ||
    JSON.stringify(i)
  const flat = v.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? flat.slice(0, 200) + '…' : flat
}

// Render a tool call as a settings.json-style permission rule, e.g.
// `Bash(npm run build)` or `Read(/path/to/file)`. Keys off the same identifying
// field as summarizeToolInput but leaves it untruncated, so the popup can show —
// and let the user grant — the exact invocation. A tool with no obvious
// specifier becomes a bare tool name.
function toolRule(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name
  const i = input as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const spec =
    str('command') ||
    str('file_path') ||
    str('path') ||
    str('pattern') ||
    str('query') ||
    str('url')
  return spec ? `${name}(${spec})` : name
}

// Pull the before/after hunks out of a file-writing tool's input so the UI can
// show its diff: Edit is one hunk (old_string → new_string), MultiEdit is one
// per entry, and Write is a single hunk against an empty original. Returns
// undefined for any other tool. Each side is capped so a giant edit can't bloat
// the task file; the UI only needs a readable peek.
function diffEdits(
  name: string,
  input: unknown,
): { old: string; new: string }[] | undefined {
  if (!input || typeof input !== 'object') return undefined
  const i = input as Record<string, unknown>
  const cap = (v: unknown) => {
    const s = typeof v === 'string' ? v : ''
    return s.length > 4000 ? s.slice(0, 4000) + '\n…' : s
  }
  if (name === 'Edit') {
    if (typeof i.old_string === 'string' && typeof i.new_string === 'string')
      return [{ old: cap(i.old_string), new: cap(i.new_string) }]
  } else if (name === 'Write') {
    if (typeof i.content === 'string') return [{ old: '', new: cap(i.content) }]
  } else if (name === 'MultiEdit') {
    if (Array.isArray(i.edits))
      return i.edits
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({
          old: cap((e as Record<string, unknown>).old_string),
          new: cap((e as Record<string, unknown>).new_string),
        }))
  }
  return undefined
}

// Whether a tool_result's text reads like a permission refusal — the agent
// asked to use a tool it wasn't granted — rather than the tool running and
// failing for some other reason. Claude Code phrases non-interactive denials a
// few ways; match the common ones. Only consulted when is_error is set.
function isPermissionDenial(text: string): boolean {
  return /requested permissions|permission to use|haven't granted|hasn't been granted|requires approval|permission denied|not allowed to use|isn't allowed|user (has )?(denied|rejected)/i.test(
    text,
  )
}

// Concatenate a tool_result block's content (a plain string or an array of
// content blocks) into its raw text, preserving newlines.
function rawToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((b) => (b && typeof b === 'object' ? String((b as any).text ?? '') : ''))
      .join('')
  return ''
}

// Flatten a tool_result's content to a single whitespace-collapsed line — for
// substring matching (e.g. permission-denial detection), not for display.
function flattenToolResult(content: unknown): string {
  return rawToolResultText(content).replace(/\s+/g, ' ').trim()
}

// A short text peek at a tool_result for the activity trace. Keeps line breaks
// so multi-line output stays readable, but caps the peek at 200 characters or 3
// lines, whichever comes first. A character cap appends an inline ellipsis; a
// line cap puts the ellipsis on its own line.
function summarizeToolResult(content: unknown): string {
  let text = rawToolResultText(content).trim()
  let charCapped = false
  if (text.length > 200) {
    text = text.slice(0, 200)
    charCapped = true
  }
  const lines = text.split('\n')
  if (lines.length > 3) return lines.slice(0, 3).join('\n') + '\n…'
  return charCapped ? text + '…' : text
}

// Append a permission rule to a project's .claude/settings.local.json — the
// gitignored per-user overrides file the CLI already reads — creating the file
// and directory as needed. Deduped so repeated grants don't pile up.
async function addProjectAllow(projectPath: string, rule: string): Promise<void> {
  const dir = path.join(projectPath, '.claude')
  const file = path.join(dir, 'settings.local.json')
  let settings: Record<string, any> = {}
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed && typeof parsed === 'object') settings = parsed
  } catch {
    // missing or invalid — start fresh
  }
  const perms = (settings.permissions ??= {})
  const allow: string[] = Array.isArray(perms.allow)
    ? perms.allow
    : (perms.allow = [])
  if (!allow.includes(rule)) allow.push(rule)
  await mkdir(dir, { recursive: true })
  await writeFile(file, JSON.stringify(settings, null, 2) + '\n')
}

// Locate the in-flight assistant message (the one runClaude is streaming into).
function pendingMessage(task: Task): Message | undefined {
  for (let i = task.messages.length - 1; i >= 0; i--) {
    const m = task.messages[i]
    if (m.role === 'assistant' && m.pending) return m
  }
  return undefined
}

// Get the in-flight assistant message, creating it on first use. We hold off on
// adding it until claude actually starts responding so its `createdAt` reflects
// when the agent began — not when the turn was queued — and so the UI can show a
// spinner under the user's message during the wait. Until then a riding task has
// no trailing assistant message.
function ensurePending(task: Task): Message {
  let msg = pendingMessage(task)
  if (!msg) {
    msg = {
      role: 'assistant',
      text: '',
      createdAt: new Date().toISOString(),
      steps: [],
      pending: true,
    }
    task.messages.push(msg)
  }
  return msg
}

// Parse one line of claude's stream-json output into the activity steps it
// contributes and any final reply text it carries. Pure — given a line, it
// returns what to append — so the same reduction serves both a live child
// process and a run read back from its on-disk log.
function reduceStreamLine(
  line: string,
  at: string,
): { steps: Step[]; finalText?: string } {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return { steps: [] }
  }
  const steps: Step[] = []
  let finalText: string | undefined
  if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'text' && block.text) {
        steps.push({ kind: 'text', text: block.text, createdAt: at })
        finalText = block.text
      } else if (block.type === 'tool_use') {
        steps.push({
          kind: 'tool_use',
          tool: block.name,
          input: summarizeToolInput(block.input),
          toolUseId: block.id,
          rule: toolRule(block.name, block.input),
          edits: diffEdits(block.name, block.input),
          createdAt: at,
        })
      }
    }
  } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    for (const block of ev.message.content) {
      if (block.type === 'tool_result') {
        const flat = flattenToolResult(block.content)
        const isError = block.is_error === true
        steps.push({
          kind: 'tool_result',
          text: summarizeToolResult(block.content),
          toolUseId: block.tool_use_id,
          isError,
          blocked: isError && isPermissionDenial(flat),
          createdAt: at,
        })
      }
    }
  } else if (ev.type === 'result' && typeof ev.result === 'string') {
    finalText = ev.result
  }
  return { steps, finalText }
}

// The shape a turn's runner reads from its run dir's job.json. The server writes
// it; bin/lander's `run` command consumes it. Everything the runner needs to
// launch claude and where to record its progress lives here, so the runner needs
// no other knowledge of tasks or the server.
type RunJob = {
  runId: string
  taskId: string
  project: string
  cwd: string
  claudeArgs: string[]
  env: Record<string, string>
  logPath: string
  leasePath: string
  donePath: string
  idleTimeoutMs: number
}

// The runner refreshes its lease while alive; the server treats a lease whose
// heartbeat is older than this (and whose pid is gone) as a dead run.
const HEARTBEAT_STALE_MS = 20_000
// How long to wait for a freshly-launched runner to write its first lease before
// concluding it failed to start. Generous: a cold `node` start can take a beat.
const RUN_START_GRACE_MS = 20_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Read a file, or null if it's missing/unreadable — used for the optional
// lease/done markers a run may or may not have written yet.
async function readFileMaybe(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

function safeParse<T>(raw: string | null): T | null {
  if (raw == null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// Whether a process is still around. kill(pid, 0) sends no signal but throws if
// the pid is gone; EPERM means it exists but isn't ours, which still counts.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

// Build the argv for one claude turn from the task's permissions and the prompt.
// The first turn establishes the session with `--session-id`; later turns
// continue it with `--resume`. Output is stream-json so the runner can stream
// each event to the log as it arrives.
function buildClaudeArgs(
  task: Task,
  id: string,
  prompt: string,
  mode: 'start' | 'resume',
): string[] {
  const sessionArgs = mode === 'start' ? ['--session-id', id] : ['--resume', id]
  const allowed: string[] = ['Bash(lander:*)']
  if (task.allowEdits) allowed.push('Edit', 'Write', 'MultiEdit')
  if (task.allowCommits) allowed.push('Bash(git:*)')
  if (task.allow?.length) allowed.push(...task.allow)
  // Pass each rule as its own argument (the flag is variadic) rather than one
  // space-joined string: a rule like `Bash(sed -n '1,5p':*)` contains spaces,
  // and joining leaves claude to re-split on them, which mangles the rule and
  // silently drops it. Separate argv entries keep each rule intact.
  const editArgs = allowed.length ? ['--allowedTools', ...allowed] : []

  // Tell the agent what edit/commit permissions it holds, so it knows what it
  // is allowed to forward to a task it spawns. A task can only pass on access
  // it has itself.
  const held = [
    task.allowEdits && 'editing files',
    task.allowCommits && 'git commits',
  ].filter(Boolean) as string[]
  const forwardable = held.length
    ? `You currently have permission for ${held.join(' and ')}, and can ` +
      'forward that to a spawned task'
    : 'You currently have no edit or commit permissions, so a spawned task ' +
      'cannot be granted them either'

  return [
    ...sessionArgs,
    ...editArgs,
    '--append-system-prompt',
    'You are running inside a lander task. Manage yourself with the `lander` ' +
      'CLI: `lander status <state>` sets any status; `lander wedge` marks it ' +
      'wedged; `lander land` marks it landed; `lander new <message>` ' +
      'spawns a sibling task that runs independently. Pass `--title <title>` to ' +
      'name the spawned task yourself instead of having one generated — use a ' +
      'concise 2-5 word title in sentence case, with no quotes and no trailing ' +
      'punctuation. Pass `--date <when>` (any date/time the server can parse, ' +
      'e.g. an ISO timestamp) or `--time <minutes>` (a number of minutes from ' +
      'now) to defer its launch: it rests until then and the server runs it at ' +
      'that time; the two are mutually exclusive. Pass `--await <ids>` (a ' +
      'comma-separated list of task ids) to instead defer the launch until those ' +
      'tasks have all landed; combine it with `--date`/`--time` to launch on ' +
      'whichever comes first. `lander rest` takes the same `--date`/`--time`/' +
      '`--await` flags (at least one required) to put the current task to rest ' +
      'with a wakeup — it resumes then with a generated "Resumed at …" message. ' +
      '`lander list` lists this project\'s tasks (`--status` filters, `--json` ' +
      'for raw); `lander view <id>` shows one task (id or unambiguous short-id ' +
      'prefix); `lander send <id> <message>` messages another task in this ' +
      'project — immediately (queued behind any turn it is mid-way through), or ' +
      'deferred with the same `--date`/`--time`/`--await` flags. When ' +
      'the user asks you to land a task, do so with `lander land`. Say ' +
      'everything you mean to say first — ' +
      'your summary, your sign-off, every last word — because running ' +
      '`lander land` ends the task: the user can see it land, so once you have ' +
      'run it there is nothing left to confirm or say. Mark it wedged ' +
      '(`lander wedge`) only when you cannot make progress without the user: ' +
      'you need tool permissions granted, a manual step performed, or a ' +
      'blocking question answered. A spawned task starts with no edit or ' +
      'commit access; ' +
      'decide deliberately whether it needs them and, if so, pass `--edits` ' +
      '(file edits) and/or `--commits` (git) to `lander new` to grant them. ' +
      `${forwardable}.`,
    '--output-format',
    'stream-json',
    '--verbose',
    '-p',
    prompt,
  ]
}

// Launch one claude turn as a detached runner that outlives this server process,
// then reduce its streamed output onto the task. The runner (bin/lander run)
// owns the claude child and appends raw stream-json to a per-run log; we only
// read that log and write task state. So if the server restarts mid-turn the
// agent keeps working, and a fresh process reattaches to the still-live run (see
// driveTask / recoverQueues). The first turn establishes the session, later ones
// resume it. Callers set "riding" via this; we record which run we're tracking
// so a reattach can find it.
async function runTurn(
  project: Project,
  id: string,
  prompt: string,
  mode: 'start' | 'resume',
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
        msg.text = `error running claude: ${message}`
        msg.pending = false
      } else {
        t.messages.push({
          role: 'assistant',
          text: `error running claude: ${message}`,
          createdAt: new Date().toISOString(),
        })
      }
    }).catch(() => {})
    return 'crashed'
  }

  // The token the in-task `lander` CLI sends back to authenticate as this task.
  // Backfilled for tasks created before tokens existed.
  const token = task.token ?? randomUUID()
  const claudeArgs = buildClaudeArgs(task, id, prompt, mode)

  const runId = randomUUID()
  const runDir = path.join(project.runsDir, runId)
  await mkdir(runDir, { recursive: true })
  const job: RunJob = {
    runId,
    taskId: id,
    project: project.slug,
    cwd: project.path,
    claudeArgs,
    env: {
      PATH: `${path.join(ROOT, 'bin')}:${process.env.PATH ?? ''}`,
      LANDER_API: `http://localhost:${port}`,
      LANDER_PROJECT: project.slug,
      LANDER_TASK: id,
      LANDER_TOKEN: token,
    },
    logPath: path.join(runDir, 'out.jsonl'),
    leasePath: path.join(runDir, 'lease.json'),
    donePath: path.join(runDir, 'done.json'),
    idleTimeoutMs: 10 * 60_000,
  }
  await writeFile(path.join(runDir, 'job.json'), JSON.stringify(job, null, 2))

  // Mark riding and record the run before launching, so a crash between here and
  // the first reduce still leaves a reattachable pointer. Don't bump updatedAt:
  // the riding flip isn't a turn boundary, and the user message that triggered
  // this run already set it. updatedAt next moves when the assistant begins.
  await mutateTask(file, (t) => {
    t.status = 'riding'
    if (!t.token) t.token = token
    t.runId = runId
    t.runCursor = 0
  })

  // Detached and unref'd, in its own process group: a signal to this server's
  // group (a manual restart, or the watcher in dev) won't reach it, so the agent
  // runs on. stdio is ignored — the runner records everything to files.
  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'bin', 'lander'), 'run', path.join(runDir, 'job.json')],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()

  return reduceRun(project, id, runId)
}

// Tail a run's append-only output log, reducing each stream-json line onto the
// task, until the runner signals completion (writes done.json) or dies without
// doing so. Resumes from the byte cursor persisted on the task, so a server that
// restarts mid-run reattaches and picks up exactly where it left off. Returns
// 'done' on normal completion (success or claude error) or 'crashed' if the
// runner vanished mid-stream.
async function reduceRun(
  project: Project,
  id: string,
  runId: string,
): Promise<'done' | 'crashed'> {
  const file = path.join(project.dataDir, `${id}.json`)
  const runDir = path.join(project.runsDir, runId)
  const logPath = path.join(runDir, 'out.jsonl')
  const leasePath = path.join(runDir, 'lease.json')
  const donePath = path.join(runDir, 'done.json')

  // The cursor lives on the task; we own it for the duration of this run (only
  // one reducer runs per task — see driveTask's `running` guard), so a local
  // copy is authoritative once seeded from disk.
  const seed = await readTask(project.dataDir, id)
  let cursor = seed?.runCursor ?? 0
  let sawLease = false
  const startedAt = Date.now()

  while (true) {
    const doneRaw = await readFileMaybe(donePath)
    const done = safeParse<{ exitCode: number; stderr?: string }>(doneRaw)

    // Fold in any new bytes. Read only the slice past the cursor so a long run's
    // log isn't re-read each poll. Stop at the last newline (a partial trailing
    // line isn't a complete event yet) — except once done, when EOF terminates
    // the final line too.
    const st = await stat(logPath).catch(() => null)
    if (st && st.size > cursor) {
      const len = st.size - cursor
      const b = Buffer.alloc(len)
      const fh = await open(logPath, 'r')
      try {
        await fh.read(b, 0, len, cursor)
      } finally {
        await fh.close()
      }
      let take = b.length
      if (!done) {
        const lastNl = b.lastIndexOf(0x0a)
        take = lastNl >= 0 ? lastNl + 1 : 0
      }
      if (take > 0) {
        const text = b.subarray(0, take).toString('utf8')
        const steps: Step[] = []
        let finalText: string | undefined
        for (const raw of text.split('\n')) {
          const line = raw.trim()
          if (!line) continue
          const reduced = reduceStreamLine(line, new Date().toISOString())
          steps.push(...reduced.steps)
          if (reduced.finalText !== undefined) finalText = reduced.finalText
        }
        cursor += take
        await mutateTask(file, (t) => {
          if (steps.length || finalText !== undefined) {
            // Bump updatedAt only on the batch that begins the assistant message
            // (creates the pending one), not on every streamed batch: streaming
            // churn shouldn't keep reordering the sidebar.
            const begun = !pendingMessage(t)
            const msg = ensurePending(t)
            if (steps.length) msg.steps = [...(msg.steps ?? []), ...steps]
            // Carry the running reply text onto the message as it lands so it
            // survives a restart (the cursor won't replay it).
            if (finalText !== undefined) msg.text = finalText
            if (begun) t.updatedAt = msg.createdAt
          }
          t.runCursor = cursor
        }).catch(() => {})
      }
    }

    if (done) {
      await mutateTask(file, (t) => {
        const msg = ensurePending(t)
        // A non-zero exit with no reply text is an error to surface; otherwise
        // the reduced text stands as the reply.
        if (!msg.text && done.exitCode !== 0)
          msg.text =
            `error running claude: exited ${done.exitCode}` +
            (done.stderr?.trim() ? `\n${done.stderr.trim()}` : '')
        msg.pending = false
        t.updatedAt = new Date().toISOString()
        delete t.runId
        delete t.runCursor
      }).catch(() => {})
      return 'done'
    }

    // No done marker yet: is the runner still alive? It refreshes its lease while
    // running, so a stale heartbeat with a gone pid means it died mid-stream.
    const lease = safeParse<{ pid: number; heartbeatAt: string }>(
      await readFileMaybe(leasePath),
    )
    if (lease) sawLease = true
    const fresh =
      lease?.heartbeatAt &&
      Date.now() - Date.parse(lease.heartbeatAt) < HEARTBEAT_STALE_MS
    const alive = lease?.pid != null && pidAlive(lease.pid)
    const startupExpired =
      !sawLease && Date.now() - startedAt > RUN_START_GRACE_MS
    if ((sawLease && !fresh && !alive) || startupExpired) {
      await mutateTask(file, (t) => {
        const msg = pendingMessage(t)
        if (msg) {
          if (!msg.text) msg.text = 'error running claude: run interrupted'
          msg.pending = false
          t.updatedAt = new Date().toISOString()
        }
        delete t.runId
        delete t.runCursor
      }).catch(() => {})
      return 'crashed'
    }

    await sleep(200)
  }
}

// Tasks with a claude run (and its queue drain) in flight, keyed by task id.
// Guards against spawning a second concurrent process on the same session: a
// follow-up that arrives while this is set is appended to the task's `queued`
// array and picked up by the active drainer instead.
const running = new Set<string>()

// Drive a task's turns to completion: run the given opening turn, then drain
// any messages queued onto the task while it ran — one resume turn each — until
// the queue empties. Only one drainer runs per task at a time. We come to rest
// at "resting" once the queue is empty, unless the agent set its own status
// mid-run (e.g. `lander wedge` to ask for input, or `lander land`), which we
// must not clobber.
async function driveTask(
  project: Project,
  id: string,
  firstMode: 'start' | 'resume',
): Promise<void> {
  if (running.has(id)) return
  running.add(id)
  const file = path.join(project.dataDir, `${id}.json`)
  let mode = firstMode
  try {
    // Reattach first: if a previous turn's run is still tracked (its runner
    // outlived a server restart, or finished while we were down), finish
    // reducing it before starting anything queued. Afterwards the session is
    // established iff the task has any assistant turn, so derive the mode for
    // the queue drain from that rather than the caller's hint.
    const existing = await readTask(project.dataDir, id)
    if (existing?.runId) {
      await reduceRun(project, id, existing.runId)
      const after = await readTask(project.dataDir, id)
      mode = after?.messages.some((m) => m.role === 'assistant')
        ? 'resume'
        : 'start'
    }
    while (true) {
      let prompt: string | undefined
      await mutateTask(file, (t) => {
        if (t.queued && t.queued.length) prompt = t.queued.shift()
      }).catch(() => {})
      if (prompt === undefined) break
      await runTurn(project, id, prompt, mode)
      mode = 'resume'
    }
  } finally {
    running.delete(id)
    await mutateTask(file, (t) => {
      if (t.status === 'riding') t.status = 'resting'
    }).catch(() => {})
  }

  // A follow-up can land after our final drain read but before we left the
  // running set, with the sender seeing us as still active and so not starting
  // its own drainer. Re-check once and pick it back up if so. The session
  // already exists by now, so resume.
  let leftover = false
  await mutateTask(file, (t) => {
    leftover = !!(t.queued && t.queued.length)
  }).catch(() => {})
  if (leftover) void driveTask(project, id, 'resume')
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
  if (go) void driveTask(project, id, everRan ? 'resume' : 'start')
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
  let everRan = false
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
    everRan = t.messages.some((m) => m.role === 'assistant')
    const at = new Date().toISOString()
    // Delivery revives a wedged/landed recipient, same as a live send; record
    // the transition a hair ahead of the messages so the timeline orders right.
    recordStatusTransition(t, 'riding', new Date(Date.parse(at) - 1).toISOString())
    for (const m of due) {
      t.messages.push({ role: 'user', text: m.text, createdAt: at })
      ;(t.queued ??= []).push(m.text)
    }
    t.status = 'riding'
    t.updatedAt = at
    drive = true
  }).catch(() => {})
  // Mirror the /messages endpoint: a run already in flight drains the queue when
  // it finishes; otherwise start a drainer now. Resume if the session exists.
  if (drive && !running.has(id))
    void driveTask(project, id, everRan ? 'resume' : 'start')
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
      // Then launch a deferred task whose trigger has fired: its scheduled time
      // has come, or every task it awaits has landed (whichever first).
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

// Read the Claude Code OAuth access token the same way the CLI stores it: from
// the macOS keychain under "Claude Code-credentials", falling back to the
// ~/.claude/.credentials.json file used on Linux. Returns null if neither is
// available (e.g. API-key auth), which the /api/usage route reports as 503.
async function readOAuthToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w',
    ])
    const token = JSON.parse(stdout)?.claudeAiOauth?.accessToken
    if (typeof token === 'string' && token) return token
  } catch {
    // not on macOS, or no keychain entry — try the file fallback
  }
  try {
    const raw = await readFile(
      path.join(os.homedir(), '.claude', '.credentials.json'),
      'utf8',
    )
    const token = JSON.parse(raw)?.claudeAiOauth?.accessToken
    if (typeof token === 'string' && token) return token
  } catch {
    // no credentials file either
  }
  return null
}

type UsageWindow = { utilization: number; resetsAt: string | null }

// Coerce a reset moment to an ISO string. The rate-limit data carries it as a
// Unix epoch (seconds) — the statusline feeds it straight to `date -r` — so a
// bare number (or all-digit string) is seconds-since-epoch; anything else is
// assumed already ISO.
function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v))
    return new Date(v * 1000).toISOString()
  if (typeof v === 'string' && v)
    return /^\d+$/.test(v) ? new Date(Number(v) * 1000).toISOString() : v
  return null
}

// Normalize one window of the usage payload. Mirrors the fields the statusline
// reads (`used_percentage`, `resets_at`); `utilization` is the 0-100 percentage.
// The shape isn't a stable public API, so older spellings are tolerated too.
function pickWindow(obj: unknown): UsageWindow | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const raw = o.used_percentage ?? o.utilization ?? o.percent ?? 0
  const utilization = typeof raw === 'number' ? raw : Number(raw)
  return {
    utilization: Number.isFinite(utilization) ? utilization : 0,
    resetsAt: toIso(o.resets_at ?? o.resetsAt ?? o.reset_at ?? o.reset),
  }
}

// Cache usage briefly so the UI's poll doesn't hammer the upstream endpoint or
// the keychain. The window resets/utilization move slowly, so 60s is plenty.
let usageCache: { at: number; body: unknown } | null = null
const USAGE_TTL_MS = 60_000

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
  | { kind: 'task'; task: Task; slug: string }
  | { kind: 'anon' }

async function resolvePrincipal(req: {
  header(name: string): string | undefined
}): Promise<Principal> {
  if (req.header('x-lander-ui-token') === UI_TOKEN) return { kind: 'ui' }
  const token = req.header('x-lander-token')
  const taskId = req.header('x-lander-task')
  const projectSlug = req.header('x-lander-project')
  if (token && taskId && projectSlug && UUID.test(taskId)) {
    const project = PROJECT_BY_SLUG.get(projectSlug)
    const task = project && (await readTask(project.dataDir, taskId))
    // Constant value compare is fine here: the token is a random UUID, so a
    // timing side-channel doesn't meaningfully narrow the search space.
    if (task && task.token && task.token === token)
      return { kind: 'task', task, slug: projectSlug }
  }
  return { kind: 'anon' }
}

const app = new Hono()

// Current Claude subscription usage: the 5-hour session window and the 7-day
// weekly window, each as { utilization (0-100), resetsAt }. Mirrors what the
// `/usage` command in the Claude CLI shows, read from the same OAuth endpoint.
app.get('/api/usage', async (c) => {
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS)
    return c.json(usageCache.body)
  const token = await readOAuthToken()
  if (!token)
    return c.json({ error: 'no Claude OAuth token available' }, 503)
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    })
    if (!res.ok)
      return c.json({ error: `usage endpoint returned ${res.status}` }, 502)
    const data = (await res.json()) as Record<string, unknown>
    // The statusline reads `.rate_limits.{five_hour,seven_day}`; tolerate the
    // windows living at the top level too in case the endpoint differs.
    const rl =
      (data.rate_limits as Record<string, unknown> | undefined) ?? data
    const body = {
      session: pickWindow(rl.five_hour ?? rl.fiveHour ?? rl.session),
      weekly: pickWindow(rl.seven_day ?? rl.sevenDay ?? rl.weekly),
    }
    usageCache = { at: Date.now(), body }
    return c.json(body)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502)
  }
})

// List the configured projects; the first is the default the UI redirects to.
app.get('/api/projects', (c) =>
  c.json(PROJECTS.map((p) => ({ path: p.path, slug: p.slug }))),
)

app.get('/api/:project/tasks', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const active = await readTasks(project.dataDir)
    // By default archived tasks are hidden; `?archived=1` merges them in, each
    // tagged so the UI can mark the row and offer Restore.
    if (c.req.query('archived') !== '1')
      return c.json(active.map(publicTask))
    const archived = (await readTasks(project.archiveDir)).map((t) => ({
      ...t,
      archived: true,
    }))
    const merged = [...active, ...archived].sort((a, b) =>
      (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
    )
    return c.json(merged.map(publicTask))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// A single task by id (for `lander view`). Same public shape as the list.
app.get('/api/:project/tasks/:id', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  const id = c.req.param('id')
  if (!UUID.test(id)) return c.json({ error: 'invalid task id' }, 400)
  const task = await readTask(project.dataDir, id)
  if (!task) return c.json({ error: 'task not found' }, 404)
  return c.json(publicTask(task))
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
    if (!UUID.test(id)) return { error: `invalid await task id: ${id}` }
    if (selfId && id === selfId) return { error: 'a task cannot await itself' }
    if (!(await readTask(project.dataDir, id)))
      return { error: `await task not found: ${id}` }
  }
  return { waitFor: ids }
}

// Snapshot the awaited tasks (id + current title) for an `awaiting` event, so
// the UI can render them as links without a second lookup. A vanished task falls
// back to its short id. Ids are assumed pre-validated by resolveAwait.
async function describeAwaited(
  project: Project,
  ids: string[],
): Promise<{ session: string; title: string }[]> {
  const out: { session: string; title: string }[] = []
  for (const id of ids) {
    const t = await readTask(project.dataDir, id)
    out.push({ session: id, title: t?.title ?? id.slice(0, 8) })
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
      allowEdits?: unknown
      allowCommits?: unknown
    }>()
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const rawMessage = typeof body.message === 'string' ? body.message : ''
    const allowEdits = body.allowEdits === true
    const allowCommits = body.allowCommits === true
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
    // Only defer when there's actually a message to run later; a deferred task
    // with nothing to do would just sit resting forever.
    const deferred =
      (scheduledFor !== undefined || waitingFor !== undefined) &&
      rawMessage.trim() !== ''

    // Identify the caller once: it gates edit/commit grants below and, when a
    // task spawned this one, supplies the backlink we prepend to the message.
    const principal = await resolvePrincipal(c.req)

    // Granting a spawned task edit/commit access requires a caller that holds
    // it. The human (UI token) may grant anything; an authenticated task may
    // only pass on perms it has itself — so a task can't spawn a child more
    // privileged than itself; an unidentified caller may grant nothing.
    if (allowEdits || allowCommits) {
      if (principal.kind === 'task') {
        if (allowEdits && !principal.task.allowEdits)
          return c.json(
            { error: 'spawning task lacks edit permission to pass on' },
            403,
          )
        if (allowCommits && !principal.task.allowCommits)
          return c.json(
            { error: 'spawning task lacks commit permission to pass on' },
            403,
          )
      } else if (principal.kind !== 'ui') {
        return c.json(
          { error: 'not authorized to grant edit/commit permissions' },
          403,
        )
      }
    }

    // When a task spawns this one, lead the opening message with a link back to
    // the spawner so both the agent and a human reader can trace its origin.
    // The title is generated from rawMessage so the backlink can't skew it.
    const message =
      principal.kind === 'task'
        ? `↩ Spawned from [${principal.task.title}](/${principal.slug}/${principal.task.session})\n\n${rawMessage}`
        : rawMessage

    // Title is optional; when omitted, show a "…" placeholder and have haiku
    // name the task in the background so creation never blocks on it.
    const id = randomUUID()
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
      session: id,
      title: title || '…',
      // A deferred task rests until the scheduler launches it at scheduledFor.
      // Otherwise "riding" while claude works on the opening message (driveTask
      // flips it to "resting" when it returns), or "wedged" with no message —
      // it needs the user to supply a first prompt.
      status: deferred ? 'resting' : message.trim() ? 'riding' : 'wedged',
      createdAt: now,
      updatedAt: now,
      // Caught up as of creation: the opening message (and launch event) are the
      // creator's own, so they don't warrant an unseen dot. Anything that lands
      // afterwards — claude's reply, lifecycle events — is newer than this and
      // shows as unseen until viewed.
      seenAt: now,
      allowEdits,
      allowCommits,
      // Authenticates this task's own callbacks (see Task.token).
      token: randomUUID(),
      messages: [{ role: 'user', text: message, createdAt: now }],
      // Untitled until the first generated name amends it (setTitle), unless one
      // was supplied up front.
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

    // Fire-and-forget the title generation; the UI polls and picks it up.
    if (!title)
      void generateTitle(project.path, rawMessage)
        .then((t) => setTitle(project.dataDir, id, t))
        .catch(() => {})

    // Kick off claude in the project directory; reply is appended when it
    // finishes. A deferred task waits for the scheduler instead.
    if (message.trim() && !deferred) void driveTask(project, id, 'start')

    return c.json(publicTask(task), 201)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

app.patch('/api/:project/tasks/:id', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!UUID.test(id)) return c.json({ error: 'invalid task id' }, 400)
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
      allowCommits?: unknown
      status?: unknown
    }>()
    if (typeof body.title === 'string' && body.title.trim()) {
      const next = body.title.trim()
      // A user rename; record it (snapshotting the new name) when it actually
      // changes the title. The initial generated name goes through setTitle,
      // which amends the launch event instead — so it never lands here.
      if (next !== task.title) {
        (task.events ??= []).push({
          kind: 'renamed',
          title: next,
          createdAt: new Date().toISOString(),
        })
        task.updatedAt = new Date().toISOString()
      }
      task.title = next
    }
    // Changing a task's own edit/commit grant is a privilege escalation, so
    // only the human (UI token) may do it — otherwise a task could PATCH itself
    // to gain access it was never given. Title and status stay open: the CLI's
    // `lander status`/`land` set status, and renames are harmless.
    if (
      typeof body.allowEdits === 'boolean' ||
      typeof body.allowCommits === 'boolean'
    ) {
      const principal = await resolvePrincipal(c.req)
      if (principal.kind !== 'ui')
        return c.json(
          { error: 'only the UI may change a task’s edit/commit permissions' },
          403,
        )
      if (typeof body.allowEdits === 'boolean') task.allowEdits = body.allowEdits
      if (typeof body.allowCommits === 'boolean')
        task.allowCommits = body.allowCommits
    }
    if (typeof body.status === 'string') {
      const at = new Date().toISOString()
      recordStatusTransition(task, body.status, at)
      if (body.status !== task.status) task.updatedAt = at
      task.status = body.status
    }
    await writeFile(file, JSON.stringify(task, null, 2))
    return c.json(publicTask(task))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Launch a scheduled task immediately, ahead of its scheduled time (the UI's
// "launch" button on a resting, scheduled task). Clears the schedule, records
// the "launched" event, and drives the queued opening message.
app.post('/api/:project/tasks/:id/launch', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!UUID.test(id)) return c.json({ error: 'invalid task id' }, 400)
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
app.post('/api/:project/tasks/:id/rest', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!UUID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)
    if (!(await readTask(project.dataDir, id)))
      return c.json({ error: 'task not found' }, 404)

    const body = await c.req.json<{
      date?: unknown
      time?: unknown
      await?: unknown
    }>()
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
    if (!UUID.test(id)) return c.json({ error: 'invalid task id' }, 400)
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

// Re-title a task from its full conversation. Unlike the background generation
// at creation time, this blocks and returns the updated task so the UI can show
// the new title immediately.
app.post('/api/:project/tasks/:id/retitle', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!UUID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)

    let task: Task
    try {
      task = JSON.parse(await readFile(file, 'utf8')) as Task
    } catch {
      return c.json({ error: 'task not found' }, 404)
    }

    const transcript = task.messages
      .map((m) => `${m.role}: ${m.text}`)
      .join('\n\n')
    const next = await generateTitle(project.path, transcript)
    // A deliberate re-title (the "suggest a title" button), so record it as a
    // rename — unlike the automatic first naming, which amends the launch event.
    if (next !== task.title) {
      (task.events ??= []).push({
        kind: 'renamed',
        title: next,
        createdAt: new Date().toISOString(),
      })
      task.updatedAt = new Date().toISOString()
    }
    task.title = next
    await writeFile(file, JSON.stringify(task, null, 2))
    return c.json(publicTask(task))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

app.post('/api/:project/tasks/:id/messages', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!UUID.test(id)) return c.json({ error: 'invalid task id' }, 400)
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
    // who sent it. A task messaging itself, or the human via the UI, is bare.
    const message =
      principal.kind === 'task' && principal.task.session !== id
        ? `✉ From [${principal.task.title}](/${principal.slug}/${principal.task.session})\n\n${rawMessage}`
        : rawMessage

    // A `--date`/`--time` and/or `--await` send defers delivery; absent all,
    // deliver now.
    const sched = resolveSchedule(body)
    if ('error' in sched) return c.json({ error: sched.error }, 400)
    const awaited = await resolveAwait(project, body.await)
    if ('error' in awaited) return c.json({ error: awaited.error }, 400)
    const deliverAt = sched.scheduledFor ?? undefined
    const waitFor = awaited.waitFor.length ? awaited.waitFor : undefined

    if (deliverAt || waitFor) {
      // Stash on the recipient; the scheduler delivers and drives it when the
      // trigger fires (the due time or all awaited tasks landing, whichever
      // first). Don't touch status or queue now — the recipient may be resting
      // (or even landed) until then. mutateTask avoids clobbering a concurrent
      // run.
      await mutateTask(file, (t) => {
        ;(t.scheduledMessages ??= []).push({ text: message, deliverAt, waitFor })
      })
      const updated = await readTask(project.dataDir, id)
      return c.json(publicTask(updated ?? task))
    }

    const now = new Date().toISOString()
    // Sending revives a wedged or landed (terminal) task — record the
    // "un-wedged"/"un-landed" transition a hair before the message's own
    // timestamp so the timeline shows it ahead of the message that caused it.
    recordStatusTransition(task, 'riding', new Date(Date.parse(now) - 1).toISOString())
    task.messages.push({ role: 'user', text: message, createdAt: now })
    task.updatedAt = now
    // Queue the prompt for the session and go "riding". driveTask clears it to
    // "resting" once the queue drains.
    task.queued = [...(task.queued ?? []), message]
    task.status = 'riding'
    await writeFile(file, JSON.stringify(task, null, 2))

    // If a run is already in flight it will drain this message when it
    // finishes; otherwise start a drainer to resume the session now.
    if (!running.has(id)) void driveTask(project, id, 'resume')

    return c.json(publicTask(task))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

// Grant a permission rule the agent was blocked on. scope "task" appends it to
// this task's `allow` list (fed to --allowedTools on future turns); scope
// "project" writes it to the project's .claude/settings.local.json so every
// task in the project inherits it. The rule comes from the popup's textarea, so
// the user may have edited it before granting.
app.post('/api/:project/tasks/:id/allow', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const id = c.req.param('id')
    if (!UUID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)

    // Granting a tool rule widens what the agent can run, so it's the human's
    // call: only the UI may do it. A task can't self-grant past its sandbox.
    if ((await resolvePrincipal(c.req)).kind !== 'ui')
      return c.json({ error: 'not authorized to grant tool permissions' }, 403)

    const body = await c.req.json<{ rule?: unknown; scope?: unknown }>()
    const rule = typeof body.rule === 'string' ? body.rule.trim() : ''
    const scope = body.scope === 'project' ? 'project' : 'task'
    if (!rule) return c.json({ error: 'rule is required' }, 400)

    if (scope === 'project') {
      await addProjectAllow(project.path, rule)
    } else {
      try {
        await mutateTask(file, (t) => {
          const allow = (t.allow ??= [])
          if (!allow.includes(rule)) allow.push(rule)
        })
      } catch {
        return c.json({ error: 'task not found' }, 404)
      }
    }
    return c.json({ ok: true, rule, scope })
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
    if (!UUID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(project.dataDir, `${id}.json`)

    const body = await c.req.json<{ at?: unknown }>()
    const at = typeof body.at === 'string' ? body.at : ''
    if (!at) return c.json({ error: 'at is required' }, 400)

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

// On boot, recover tasks the previous process left mid-flight so they aren't
// stranded. Nothing in this fresh process is driving them yet (the in-memory
// `running` set is empty), so a task can be left in one of these states:
//
//   - a run still in flight: it carries a runId. Its detached runner may still
//     be alive (it outlived the server) or have finished while we were down —
//     either way driveTask reattaches and finishes reducing it, uninterrupted.
//     Only if the runner is gone without having written its done marker was the
//     run truly interrupted; that falls through to the replay handling below.
//   - queued messages that never got drained — resume and drain them.
//   - interrupted mid-run with no recoverable runner: left "riding" with an
//     empty queue, because driveTask shifts a prompt off the queue *before*
//     running it, so a restart mid-turn loses the queue entry and the status is
//     never reset. These would otherwise sit "riding" with a stale `pending`
//     message forever.
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

      // A tracked run: reattach if its runner is still alive or already wrote a
      // done marker (driveTask reduces it to completion). If neither, the run
      // was interrupted — drop the tracking and fall through to replay it.
      if (task.runId) {
        const runDir = path.join(project.runsDir, task.runId)
        const done = (await readFileMaybe(path.join(runDir, 'done.json'))) != null
        const lease = safeParse<{ pid: number; heartbeatAt: string }>(
          await readFileMaybe(path.join(runDir, 'lease.json')),
        )
        const fresh =
          lease?.heartbeatAt &&
          Date.now() - Date.parse(lease.heartbeatAt) < HEARTBEAT_STALE_MS
        const alive = lease?.pid != null && pidAlive(lease.pid)
        if (done || fresh || alive) {
          void driveTask(project, id, 'resume')
          continue
        }
        await mutateTask(file, (t) => {
          delete t.runId
          delete t.runCursor
        }).catch(() => {})
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
            // display message; driveTask will run it as a fresh "start".
            const opening = [...t.messages]
              .reverse()
              .find((m) => m.role === 'user')
            if (opening) (t.queued ??= []).push(opening.text)
          }
        }
      }).catch(() => {})
      void driveTask(project, id, everRan ? 'resume' : 'start')
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

const port = Number(process.env.PORT ?? 6181)
const server = serve({ fetch: app.fetch, port })
console.log(`api listening on http://localhost:${port}`)
console.log('projects:')
for (const p of PROJECTS) console.log(`  ${p.slug}  ${p.path}`)
void backfillSeen()
void recoverQueues()
// Launch due scheduled tasks on boot (catching any whose time passed while the
// server was down), then sweep every 15s to launch each as it comes due.
void launchScheduled()
const scheduler = setInterval(() => void launchScheduled(), 15_000)

// Shut down cleanly when the watcher restarts us (or on Ctrl-C): stop the
// scheduler and let the HTTP server finish the requests already in flight before
// exiting, so a reload doesn't drop a write mid-flight. In-flight runs need no
// special handling — they're detached and keep going, and the fresh process
// reattaches to them via the cursor persisted on each task. A timeout forces the
// exit if a connection refuses to close, so a reload can't hang.
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
