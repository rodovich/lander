import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile, mkdir, rename } from 'node:fs/promises'
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

type Project = { path: string; slug: string; dataDir: string }

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
  kind: 'launched' | 'wedged' | 'unwedged' | 'landed' | 'unlanded' | 'renamed'
  // The task's title at the time of the event. Absent on a launch event until
  // the first generated name amends it, and on events saved before titles were
  // captured.
  title?: string
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
function publicTask(task: Task): Omit<Task, 'token'> {
  const { token: _token, ...rest } = task
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
  // This is the first generated name for a task launched untitled: fill it into
  // the launch event rather than recording it as a rename.
  const launch = task.events?.find((e) => e.kind === 'launched')
  if (launch && !launch.title) launch.title = title
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

// Flatten a tool_result block's content (a plain string or an array of content
// blocks) to a single whitespace-collapsed line.
function flattenToolResult(content: unknown): string {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content))
    text = content
      .map((b) => (b && typeof b === 'object' ? String((b as any).text ?? '') : ''))
      .join('')
  return text.replace(/\s+/g, ' ').trim()
}

// A short text peek at a tool_result for the activity trace.
function summarizeToolResult(content: unknown): string {
  const flat = flattenToolResult(content)
  return flat.length > 200 ? flat.slice(0, 200) + '…' : flat
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

// Run claude in the project directory and stream its output onto the task as an
// in-flight assistant message. The first turn uses `--session-id <id>` to
// establish the session; later turns use `--resume <id>` to continue it. We
// spawn with `--output-format stream-json` and append a `step` per event so the
// polling UI can watch progress instead of waiting for the whole run. Fire-and-
// forget; callers set the task to "riding" before invoking and we clear it back
// to "resting" once claude returns.
async function runClaude(
  project: Project,
  id: string,
  prompt: string,
  mode: 'start' | 'resume',
): Promise<void> {
  const sessionArgs =
    mode === 'start' ? ['--session-id', id] : ['--resume', id]
  const file = path.join(project.dataDir, `${id}.json`)
  try {
    const task = JSON.parse(await readFile(file, 'utf8')) as Task
    // The token the in-task `lander` CLI sends back to authenticate as this
    // task. Backfilled for tasks created before tokens existed.
    const token = task.token ?? randomUUID()
    const allowed: string[] = ['Bash(lander:*)']
    if (task.allowEdits) allowed.push('Edit', 'Write', 'MultiEdit')
    if (task.allowCommits) allowed.push('Bash(git:*)')
    if (task.allow?.length) allowed.push(...task.allow)
    // Pass each rule as its own argument (the flag is variadic) rather than one
    // space-joined string: a rule like `Bash(sed -n '1,5p':*)` contains spaces,
    // and joining leaves claude to re-split on them, which mangles the rule and
    // silently drops it. Separate argv entries keep each rule intact.
    const editArgs = allowed.length ? ['--allowedTools', ...allowed] : []

    // Mark the task riding now, but don't create the assistant message yet — it
    // gets added on the first stream event (see ensurePending) so its timestamp
    // marks when claude actually began responding. Until then the UI shows a
    // spinner under the last user message.
    // Don't bump updatedAt here: the riding flip isn't a turn boundary, and the
    // user message that triggered this run already set it. updatedAt next moves
    // when the assistant actually begins responding (see the stream handler).
    await mutateTask(file, (t) => {
      t.status = 'riding'
      if (!t.token) t.token = token
    })

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

    const args = [
      ...sessionArgs,
      ...editArgs,
      '--append-system-prompt',
      'You are running inside a lander task. Manage yourself with the `lander` ' +
        'CLI: `lander land` marks this task landed; `lander wedge` marks it ' +
        'wedged; `lander status <state>` sets any status; `lander new <message>` ' +
        'spawns a sibling task that runs independently. When you finish a turn ' +
        'the task comes to rest on its own — you need do nothing. Mark it wedged ' +
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

    await new Promise<void>((resolve) => {
      const child = spawn('claude', args, {
        cwd: project.path,
        env: {
          ...process.env,
          PATH: `${path.join(ROOT, 'bin')}:${process.env.PATH ?? ''}`,
          LANDER_API: `http://localhost:${port}`,
          LANDER_PROJECT: project.slug,
          LANDER_TASK: id,
          LANDER_TOKEN: token,
        },
      })
      let buf = ''
      let stderr = ''
      let finalText = ''
      let settled = false

      // spawn has no built-in timeout; kill the run after 10 minutes like the
      // old execFile timeout did.
      const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000)

      const finish = async (errText?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        await mutateTask(file, (t) => {
          const msg = ensurePending(t)
          msg.text = errText ?? finalText
          msg.pending = false
          t.updatedAt = new Date().toISOString()
        }).catch(() => {})
        resolve()
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buf += chunk
        const steps: Step[] = []
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let ev: any
          try {
            ev = JSON.parse(line)
          } catch {
            continue
          }
          const at = new Date().toISOString()
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
                  text: flat.length > 200 ? flat.slice(0, 200) + '…' : flat,
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
        }
        if (steps.length)
          void mutateTask(file, (t) => {
            // Bump updatedAt only on the batch that begins the assistant message
            // (i.e. creates the pending message), not on every streamed batch:
            // streaming churn shouldn't keep reordering the sidebar.
            const begun = !pendingMessage(t)
            const msg = ensurePending(t)
            msg.steps = [...(msg.steps ?? []), ...steps]
            if (begun) t.updatedAt = msg.createdAt
          }).catch(() => {})
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk
      })

      child.on('error', (e) => {
        void finish(`error running claude: ${e.message}`)
      })
      child.on('close', (code) => {
        if (code === 0 || finalText) void finish()
        else
          void finish(
            `error running claude: exited ${code}` +
              (stderr.trim() ? `\n${stderr.trim()}` : ''),
          )
      })
    })
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
    while (true) {
      let prompt: string | undefined
      await mutateTask(file, (t) => {
        if (t.queued && t.queued.length) prompt = t.queued.shift()
      }).catch(() => {})
      if (prompt === undefined) break
      await runClaude(project, id, prompt, mode)
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
    return c.json((await readTasks(project.dataDir)).map(publicTask))
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

app.post('/api/:project/tasks', async (c) => {
  const project = PROJECT_BY_SLUG.get(c.req.param('project'))
  if (!project) return c.json({ error: 'unknown project' }, 404)
  try {
    const body = await c.req.json<{
      title?: unknown
      message?: unknown
      allowEdits?: unknown
      allowCommits?: unknown
    }>()
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const rawMessage = typeof body.message === 'string' ? body.message : ''
    const allowEdits = body.allowEdits === true
    const allowCommits = body.allowCommits === true
    if (!title && !rawMessage.trim())
      return c.json({ error: 'title or message is required' }, 400)

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
    const task: Task = {
      session: id,
      title: title || '…',
      // "riding" while claude works on the opening message; driveTask flips it
      // to "resting" when it returns. With no message there's nothing to run,
      // and the task is "wedged" — it needs the user to supply a first prompt.
      status: message.trim() ? 'riding' : 'wedged',
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
      // A launch event, timestamped a hair before the opening message so the
      // timeline shows it ahead of that message. Untitled until the first
      // generated name amends it (setTitle), unless one was supplied up front.
      events: [
        {
          kind: 'launched',
          title: title || undefined,
          createdAt: new Date(Date.parse(now) - 1).toISOString(),
        },
      ],
      // The opening message rides the same queue as follow-ups; driveTask
      // drains it. It stays in `messages` above for display.
      queued: message.trim() ? [message] : [],
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

    // Kick off claude in the project directory; reply is appended when it finishes.
    if (message.trim()) void driveTask(project, id, 'start')

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

    const body = await c.req.json<{ message?: unknown }>()
    const message = typeof body.message === 'string' ? body.message : ''
    if (!message.trim()) return c.json({ error: 'message is required' }, 400)

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

// On boot, resume any tasks that still have queued messages from before a
// restart so they aren't stranded. Their in-flight run (if any) died with the
// old process, so clear stale `pending` flags first, then drive the queue. A
// task with no assistant turn yet never established its session — start it.
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
      if (!task.queued || task.queued.length === 0) continue
      const everRan = task.messages.some((m) => m.role === 'assistant')
      await mutateTask(file, (t) => {
        for (const m of t.messages) if (m.pending) m.pending = false
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
serve({ fetch: app.fetch, port })
console.log(`api listening on http://localhost:${port}`)
console.log('projects:')
for (const p of PROJECTS) console.log(`  ${p.slug}  ${p.path}`)
void backfillSeen()
void recoverQueues()
