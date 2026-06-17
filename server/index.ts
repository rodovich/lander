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

type Task = {
  session: string
  title: string
  status: string
  createdAt: string
  // Bumped to the latest message's timestamp whenever a message is sent or
  // received; drives the sidebar sort order. Falls back to createdAt for tasks
  // saved before this field existed.
  updatedAt: string
  allowEdits: boolean
  allowCommits: boolean
  messages: Message[]
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

async function setTitle(
  dataDir: string,
  id: string,
  title: string,
): Promise<void> {
  const file = path.join(dataDir, `${id}.json`)
  const task = JSON.parse(await readFile(file, 'utf8')) as Task
  task.title = title
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

// Pull a short text peek out of a tool_result block, whose content is either a
// plain string or an array of content blocks.
function summarizeToolResult(content: unknown): string {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content))
    text = content
      .map((b) => (b && typeof b === 'object' ? String((b as any).text ?? '') : ''))
      .join('')
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? flat.slice(0, 200) + '…' : flat
}

// Locate the in-flight assistant message (the one runClaude is streaming into).
function pendingMessage(task: Task): Message | undefined {
  for (let i = task.messages.length - 1; i >= 0; i--) {
    const m = task.messages[i]
    if (m.role === 'assistant' && m.pending) return m
  }
  return undefined
}

// Run claude in the project directory and stream its output onto the task as an
// in-flight assistant message. The first turn uses `--session-id <id>` to
// establish the session; later turns use `--resume <id>` to continue it. We
// spawn with `--output-format stream-json` and append a `step` per event so the
// polling UI can watch progress instead of waiting for the whole run. Fire-and-
// forget; callers set the task to "riding" before invoking and we clear it back
// to "wedged" once claude returns.
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
    const allowed: string[] = ['Bash(lander:*)']
    if (task.allowEdits) allowed.push('Edit', 'Write', 'MultiEdit')
    if (task.allowCommits) allowed.push('Bash(git:*)')
    const editArgs = allowed.length ? ['--allowedTools', allowed.join(' ')] : []

    // Seed the in-flight assistant message up front so the UI has something to
    // grow as the stream arrives.
    const startedAt = new Date().toISOString()
    await mutateTask(file, (t) => {
      t.messages.push({
        role: 'assistant',
        text: '',
        createdAt: startedAt,
        steps: [],
        pending: true,
      })
      t.status = 'riding'
      t.updatedAt = startedAt
    })

    const args = [
      ...sessionArgs,
      ...editArgs,
      '--append-system-prompt',
      'You are running inside a lander task. Manage yourself with the `lander` ' +
        'CLI: `lander land` marks this task landed; `lander status <state>` sets ' +
        'any status; `lander new <message>` spawns a sibling task that runs ' +
        'independently.',
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
          const msg = pendingMessage(t)
          if (msg) {
            msg.text = errText ?? finalText
            msg.pending = false
          }
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
                  createdAt: at,
                })
              }
            }
          } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
            for (const block of ev.message.content) {
              if (block.type === 'tool_result') {
                steps.push({
                  kind: 'tool_result',
                  text: summarizeToolResult(block.content),
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
            const msg = pendingMessage(t)
            if (!msg) return
            msg.steps = [...(msg.steps ?? []), ...steps]
            t.updatedAt = new Date().toISOString()
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
// at "wedged" once the queue is empty, unless the agent set its own terminal
// status mid-run (e.g. `lander land`), which we must not clobber.
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
      if (t.status === 'riding') t.status = 'wedged'
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
    return c.json(await readTasks(project.dataDir))
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
    const message = typeof body.message === 'string' ? body.message : ''
    const allowEdits = body.allowEdits === true
    const allowCommits = body.allowCommits === true
    if (!title && !message.trim())
      return c.json({ error: 'title or message is required' }, 400)

    // Title is optional; when omitted, show a "…" placeholder and have haiku
    // name the task in the background so creation never blocks on it.
    const id = randomUUID()
    const now = new Date().toISOString()
    const task: Task = {
      session: id,
      title: title || '…',
      // "riding" while claude works on the opening message; runClaude flips it
      // to "wedged" when it returns. With no message there's nothing to run.
      status: message.trim() ? 'riding' : 'wedged',
      createdAt: now,
      updatedAt: now,
      allowEdits,
      allowCommits,
      messages: [{ role: 'user', text: message, createdAt: now }],
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
      void generateTitle(project.path, message)
        .then((t) => setTitle(project.dataDir, id, t))
        .catch(() => {})

    // Kick off claude in the project directory; reply is appended when it finishes.
    if (message.trim()) void driveTask(project, id, 'start')

    return c.json(task, 201)
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
    if (typeof body.title === 'string' && body.title.trim())
      task.title = body.title.trim()
    if (typeof body.allowEdits === 'boolean') task.allowEdits = body.allowEdits
    if (typeof body.allowCommits === 'boolean')
      task.allowCommits = body.allowCommits
    if (typeof body.status === 'string') task.status = body.status
    await writeFile(file, JSON.stringify(task, null, 2))
    return c.json(task)
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
    task.title = await generateTitle(project.path, transcript)
    await writeFile(file, JSON.stringify(task, null, 2))
    return c.json(task)
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
    task.messages.push({ role: 'user', text: message, createdAt: now })
    task.updatedAt = now
    // Queue the prompt for the session and go "riding"; this also revives a
    // landed (terminal) task. driveTask clears it to "wedged" once the queue
    // drains.
    task.queued = [...(task.queued ?? []), message]
    task.status = 'riding'
    await writeFile(file, JSON.stringify(task, null, 2))

    // If a run is already in flight it will drain this message when it
    // finishes; otherwise start a drainer to resume the session now.
    if (!running.has(id)) void driveTask(project, id, 'resume')

    return c.json(task)
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

const port = Number(process.env.PORT ?? 6181)
serve({ fetch: app.fetch, port })
console.log(`api listening on http://localhost:${port}`)
console.log('projects:')
for (const p of PROJECTS) console.log(`  ${p.slug}  ${p.path}`)
void recoverQueues()
