import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
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

const PROJECT_DIR = process.env.PROJECT_DIR ?? process.cwd()
const DATA_DIR = path.join(ROOT, 'data', normalizeProjectPath(PROJECT_DIR), 'tasks')

type Message = {
  role: 'user' | 'assistant'
  text: string
  createdAt: string
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
}

async function readTasks(): Promise<Task[]> {
  let names: string[]
  try {
    names = await readdir(DATA_DIR)
  } catch {
    return []
  }
  const tasks: Task[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = await readFile(path.join(DATA_DIR, name), 'utf8')
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

async function appendMessage(id: string, message: Message): Promise<void> {
  const file = path.join(DATA_DIR, `${id}.json`)
  const task = JSON.parse(await readFile(file, 'utf8')) as Task
  task.messages.push(message)
  task.updatedAt = message.createdAt
  await writeFile(file, JSON.stringify(task, null, 2))
}

async function setTitle(id: string, title: string): Promise<void> {
  const file = path.join(DATA_DIR, `${id}.json`)
  const task = JSON.parse(await readFile(file, 'utf8')) as Task
  task.title = title
  await writeFile(file, JSON.stringify(task, null, 2))
}

// Ask haiku for a short 2-5 word title summarizing the task's first message.
// Falls back to a default if generation fails so task creation never blocks.
async function generateTitle(message: string): Promise<string> {
  const prompt =
    'Generate a concise 2-5 word title summarizing the following task. ' +
    'Respond with only the title — no quotes, no trailing punctuation.\n\n' +
    message
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['--model', 'haiku', '-p', prompt],
      { cwd: PROJECT_DIR, maxBuffer: 1024 * 1024, timeout: 60_000 },
    )
    const title = stdout.trim().replace(/^["']+|["'.]+$/g, '').trim()
    return title || 'Untitled task'
  } catch {
    return 'Untitled task'
  }
}

// Run claude in the project directory and append its output to the task as an
// assistant message. The first turn uses `--session-id <id>` to establish the
// session; later turns use `--resume <id>` to continue it. Fire-and-forget; the
// UI polls /api/tasks to pick up the reply once it lands.
async function runClaude(
  id: string,
  prompt: string,
  mode: 'start' | 'resume',
): Promise<void> {
  const sessionArgs =
    mode === 'start' ? ['--session-id', id] : ['--resume', id]
  try {
    const task = JSON.parse(
      await readFile(path.join(DATA_DIR, `${id}.json`), 'utf8'),
    ) as Task
    const allowed: string[] = []
    if (task.allowEdits) allowed.push('Edit', 'Write', 'MultiEdit')
    if (task.allowCommits) allowed.push('Bash(git:*)')
    const editArgs = allowed.length ? ['--allowedTools', allowed.join(' ')] : []
    const { stdout } = await execFileAsync(
      'claude',
      [...sessionArgs, ...editArgs, '-p', prompt],
      { cwd: PROJECT_DIR, maxBuffer: 50 * 1024 * 1024, timeout: 10 * 60_000 },
    )
    await appendMessage(id, {
      role: 'assistant',
      text: stdout.trim(),
      createdAt: new Date().toISOString(),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const stderr = (e as { stderr?: unknown })?.stderr
    const detail = stderr ? `\n${String(stderr).trim()}` : ''
    await appendMessage(id, {
      role: 'assistant',
      text: `error running claude: ${message}${detail}`,
      createdAt: new Date().toISOString(),
    }).catch(() => {})
  }
}

const app = new Hono()

app.get('/api/project', (c) => c.json({ path: PROJECT_DIR }))

app.get('/api/tasks', async (c) => {
  try {
    return c.json(await readTasks())
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

app.post('/api/tasks', async (c) => {
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
      status: 'wedged',
      createdAt: now,
      updatedAt: now,
      allowEdits,
      allowCommits,
      messages: [{ role: 'user', text: message, createdAt: now }],
    }

    await mkdir(DATA_DIR, { recursive: true })
    await writeFile(
      path.join(DATA_DIR, `${id}.json`),
      JSON.stringify(task, null, 2),
    )

    // Fire-and-forget the title generation; the UI polls and picks it up.
    if (!title)
      void generateTitle(message)
        .then((t) => setTitle(id, t))
        .catch(() => {})

    // Kick off claude in the project directory; reply is appended when it finishes.
    if (message.trim()) void runClaude(id, message, 'start')

    return c.json(task, 201)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

app.patch('/api/tasks/:id', async (c) => {
  try {
    const id = c.req.param('id')
    if (!UUID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(DATA_DIR, `${id}.json`)

    let task: Task
    try {
      task = JSON.parse(await readFile(file, 'utf8')) as Task
    } catch {
      return c.json({ error: 'task not found' }, 404)
    }

    const body = await c.req.json<{
      allowEdits?: unknown
      allowCommits?: unknown
      status?: unknown
    }>()
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

app.post('/api/tasks/:id/messages', async (c) => {
  try {
    const id = c.req.param('id')
    if (!UUID.test(id)) return c.json({ error: 'invalid task id' }, 400)
    const file = path.join(DATA_DIR, `${id}.json`)

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
    await writeFile(file, JSON.stringify(task, null, 2))

    // Continue the same claude session; reply is appended when it finishes.
    void runClaude(id, message, 'resume')

    return c.json(task)
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})

const port = Number(process.env.PORT ?? 6181)
serve({ fetch: app.fetch, port })
console.log(`api listening on http://localhost:${port}`)
console.log(`project: ${PROJECT_DIR}`)
console.log(`data dir: ${DATA_DIR}`)
