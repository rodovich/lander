import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeProjectPath, projectSlug } from './projects'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UI_TOKEN = 'test-ui-token'
const AT = '2026-01-01T00:00:00.000Z'

let app: (typeof import('./index'))['app']
let projectDir: string
let dataRoot: string
let tasksDir: string
let slug: string
let originalEnv: NodeJS.ProcessEnv

async function post(pathname: string, body: unknown): Promise<Response> {
  return app.request(pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-lander-ui-token': UI_TOKEN,
    },
    body: JSON.stringify(body),
  })
}

async function createTask(title: string): Promise<{ id: string; agent: string }> {
  const res = await post(`/api/${slug}/tasks`, { title })
  expect(res.status).toBe(201)
  return (await res.json()) as { id: string; agent: string }
}

beforeAll(async () => {
  originalEnv = { ...process.env }
  projectDir = await mkdtemp(path.join(tmpdir(), 'lander-server-project-'))
  slug = projectSlug(projectDir)
  dataRoot = path.join(ROOT, 'data', normalizeProjectPath(projectDir))
  tasksDir = path.join(dataRoot, 'tasks')
  await rm(dataRoot, { recursive: true, force: true })

  process.env.NODE_ENV = 'test'
  process.env.PROJECT_DIRS = projectDir
  process.env.LANDER_UI_TOKEN = UI_TOKEN
  process.env.LANDER_AGENT = 'codex'

  ;({ app } = await import('./index'))
})

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true })
  await rm(dataRoot, { recursive: true, force: true })
  process.env = originalEnv
})

describe('server task provider behavior', () => {
  it('stores the configured default provider on new tasks', async () => {
    const task = await createTask('Codex default task')

    expect(task.agent).toBe('codex')
    const raw = JSON.parse(
      await readFile(path.join(tasksDir, `${task.id}.json`), 'utf8'),
    )
    expect(raw.agent).toBe('codex')
  })

  it('serves the persisted provider instead of re-resolving the environment', async () => {
    const task = await createTask('Persisted Codex task')
    process.env.LANDER_AGENT = 'claude'

    const res = await app.request(`/api/${slug}/tasks/${task.id}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: task.id, agent: 'codex' })
  })

  it('delegates project grants to the daemon and records worktrees neutrally', async () => {
    const task = await createTask('Neutral Codex affordances')

    const grant = await post(`/api/${slug}/tasks/${task.id}/allow`, {
      scope: 'project',
      rule: 'Bash(npm test)',
    })
    expect(grant.status).toBe(503)
    expect(await grant.json()).toEqual({
      error: 'no daemon connected for this project',
    })

    const worktree = await post(`/api/${slug}/tasks/${task.id}/worktree`, {
      worktreePath: path.join(projectDir, '.claude', 'worktrees', 'feat'),
    })
    expect(worktree.status).toBe(200)
    expect(await worktree.json()).toMatchObject({ id: task.id, worktree: 'feat' })
  })

  it('stores Codex task allow rules with an unsupported warning', async () => {
    const task = await createTask('Codex task allow rule')

    const res = await post(`/api/${slug}/tasks/${task.id}/allow`, {
      scope: 'task',
      rule: 'Bash(npm test)',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      rule: 'Bash(npm test)',
      scope: 'task',
      warning: 'Saved for parity; Codex runs do not honor task allow rules yet',
    })
    const raw = JSON.parse(
      await readFile(path.join(tasksDir, `${task.id}.json`), 'utf8'),
    )
    expect(raw.allow).toEqual(['Bash(npm test)'])
  })

  it('treats legacy tasks without agent as Claude when delegating project grants', async () => {
    await mkdir(tasksDir, { recursive: true })
    await writeFile(
      path.join(tasksDir, 'legacy-task.json'),
      JSON.stringify(
        {
          id: 'legacy-task',
          title: 'Legacy task',
          status: 'resting',
          createdAt: AT,
          updatedAt: AT,
          allowEdits: false,
          messages: [],
        },
        null,
        2,
      ),
    )

    const res = await post('/api/' + slug + '/tasks/legacy-task/allow', {
      scope: 'project',
      rule: 'Bash(npm test)',
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({
      error: 'no daemon connected for this project',
    })
  })
})
