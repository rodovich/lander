import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { WebSocket } from 'ws'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  attachDaemonServer,
  closeRunChannel,
  daemonConnected,
  daemonServes,
} from './daemon'
import { normalizeProjectPath, projectSlug } from './projects'
import type { RevivedMarker } from './protocol'

const UI_TOKEN = 'test-ui-token'
const AT = '2026-01-01T00:00:00.000Z'

let app: (typeof import('./index'))['app']
let projectDir: string
let dataDirRoot: string
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

async function readTaskField(id: string, field: string): Promise<unknown> {
  const raw = JSON.parse(
    await readFile(path.join(tasksDir, `${id}.json`), 'utf8'),
  )
  return raw[field]
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
  // Point the server's data root at a temp dir rather than letting it default
  // to ./data in the checkout: the suite creates, lands and deletes tasks, and
  // a run that dies before afterAll would otherwise strand a project dir inside
  // the developer's live data — as one interrupted run in fact did.
  dataDirRoot = await mkdtemp(path.join(tmpdir(), 'lander-server-data-'))
  dataRoot = path.join(dataDirRoot, normalizeProjectPath(projectDir))
  tasksDir = path.join(dataRoot, 'tasks')

  process.env.NODE_ENV = 'test'
  process.env.LANDER_DATA_ROOT = dataDirRoot
  process.env.PROJECT_DIRS = projectDir
  process.env.LANDER_UI_TOKEN = UI_TOKEN
  process.env.LANDER_AGENT = 'codex'

  ;({ app } = await import('./index'))
})

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true })
  await rm(dataDirRoot, { recursive: true, force: true })
  process.env = originalEnv
})

describe('flow registry endpoint', () => {
  it('serves the legacy flows when no daemon has announced', async () => {
    // No daemon is connected in this suite, so this is the bootstrap window:
    // the picker must still have something to render.
    const res = await app.request(`/api/${slug}/flows`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { flows: { name: string }[] }
    expect(body.flows.map((f) => f.name)).toEqual(['claude', 'codex'])
  })

  it('serves each flow’s announced capabilities', async () => {
    const res = await app.request(`/api/${slug}/flows`)
    const body = (await res.json()) as {
      flows: { name: string; capabilities: Record<string, unknown> }[]
    }
    const claude = body.flows.find((f) => f.name === 'claude')
    const codex = body.flows.find((f) => f.name === 'codex')
    expect(claude?.capabilities).toMatchObject({
      grants: { task: true, project: true },
      reportsCost: true,
    })
    expect(codex?.capabilities).toMatchObject({
      grants: { task: false, project: false },
      reportsCost: false,
    })
  })

  it('404s an unknown project', async () => {
    const res = await app.request('/api/not-a-project/flows')
    expect(res.status).toBe(404)
  })

  it('does not shadow the command-flow :name resolver', async () => {
    // The two notions of "flow" share the word and the path prefix. The list
    // endpoint is a sibling route (different segment count), so the script
    // resolver the `lander flow` CLI depends on must still answer.
    const res = await app.request(`/api/${slug}/flows/definitely-not-there`)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({
      error: 'unknown flow: definitely-not-there',
    })
  })
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

  it('stores both flow and the legacy agent for a legacy flow', async () => {
    const task = await createTask('Derived flow task')
    const res = await app.request(`/api/${slug}/tasks/${task.id}`)
    expect(await res.json()).toMatchObject({ agent: 'codex', flow: 'codex' })
    // Both on disk: `flow` is what dispatch reads, `agent` is what a daemon
    // predating it reads.
    expect(await readTaskField(task.id, 'flow')).toBe('codex')
    expect(await readTaskField(task.id, 'agent')).toBe('codex')
  })

  it('derives a flow for a task stored before the field existed', async () => {
    // The permanent union-read. Nothing rewrites these, so this is the path
    // every pre-step-4 task takes forever.
    const id = 'legacy-derives'
    await writeFile(
      path.join(tasksDir, `${id}.json`),
      JSON.stringify({
        id,
        agent: 'claude',
        title: 'Legacy',
        status: 'resting',
        createdAt: AT,
        updatedAt: AT,
        allowEdits: false,
        shape: 2,
        items: [],
        rides: [],
      }),
    )
    const res = await app.request(`/api/${slug}/tasks/${id}`)
    expect(await res.json()).toMatchObject({ agent: 'claude', flow: 'claude' })
    expect(await readTaskField(id, 'flow')).toBeUndefined()
  })

  it('rejects an unknown flow rather than silently defaulting', async () => {
    // A silent default would make `--flow open-pr` against a daemon lacking it
    // produce a claude task that runs the prompt anyway.
    const res = await post(`/api/${slug}/tasks`, {
      title: 'Bad flow',
      flow: 'no-such-flow',
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain(
      'unknown flow: no-such-flow',
    )
  })

  it('validates flowConfig shape and size', async () => {
    // bin/ has no typecheck coverage, so the CLI's --key parsing rests on this.
    const notObject = await post(`/api/${slug}/tasks`, {
      title: 'Bad config',
      flowConfig: 'nope',
    })
    expect(notObject.status).toBe(400)
    expect(((await notObject.json()) as { error: string }).error).toContain(
      'flowConfig must be a JSON object',
    )

    const arrayConfig = await post(`/api/${slug}/tasks`, {
      title: 'Bad config',
      flowConfig: [1, 2, 3],
    })
    expect(arrayConfig.status).toBe(400)

    const tooBig = await post(`/api/${slug}/tasks`, {
      title: 'Big config',
      flowConfig: { blob: 'x'.repeat(20 * 1024) },
    })
    expect(tooBig.status).toBe(400)
    expect(((await tooBig.json()) as { error: string }).error).toContain('too large')

    const ok = await post(`/api/${slug}/tasks`, {
      title: 'Good config',
      flowConfig: { dryRun: false, attempts: 3, name: 'x' },
    })
    expect(ok.status).toBe(201)
    const created = (await ok.json()) as { id: string }
    // Types survive the round trip — not stringified.
    expect(await readTaskField(created.id, 'flowConfig')).toEqual({
      dryRun: false,
      attempts: 3,
      name: 'x',
    })
  })

  it('carries capability flags and items on GET /tasks/:id', async () => {
    // A test rather than a UI check on purpose: the UI polls only the LIST
    // endpoint (src/useTaskData.ts), so a visual pass would look fine while the
    // single-task endpoint dropped these. That endpoint is also what a flow's
    // own ctx.view() reads, and the ask-reading path depends on `items` passing
    // through publicTask untouched — so both are pinned here.
    const task = await createTask('Caps on the single-task endpoint')
    await post(`/api/${slug}/tasks/${task.id}/messages`, { message: 'hello' })

    const res = await app.request(`/api/${slug}/tasks/${task.id}`)
    const body = (await res.json()) as {
      grants?: unknown
      reportsCost?: unknown
      items?: { kind: string }[]
    }
    expect(body.grants).toEqual({ task: false, project: false }) // codex
    expect(body.reportsCost).toBe(false)
    expect(body.items?.some((i) => i.kind === 'message')).toBe(true)
  })

  it('reads an archived task on GET /tasks/:id, tagged archived', async () => {
    // `lander view` resolves an id across both pools, so the single-task endpoint
    // must fall back to the archive — otherwise a viewable id would 404.
    const task = await createTask('Archived but viewable')
    expect((await post(`/api/${slug}/tasks/${task.id}/archive`, {})).status).toBe(200)

    const res = await app.request(`/api/${slug}/tasks/${task.id}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: task.id, archived: true })
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
      // Worded from the capability, not the provider: an open-pr task declares
      // the same `grants.task: false` and would otherwise be told it was Codex.
      warning: 'Saved for parity; this flow does not honor task allow rules yet',
    })
    const raw = JSON.parse(
      await readFile(path.join(tasksDir, `${task.id}.json`), 'utf8'),
    )
    expect(raw.allow).toEqual(['Bash(npm test)'])
  })

  it('bounds the recorded cwd to the project root', async () => {
    const task = await createTask('Cwd bound task')

    // A subdir under the root is accepted and persisted.
    const sub = path.join(projectDir, 'sub', 'dir')
    const subRes = await post(`/api/${slug}/tasks/${task.id}/cwd`, { cwd: sub })
    expect(subRes.status).toBe(200)
    expect(await readTaskField(task.id, 'cwd')).toBe(sub)

    // A worktree path (under .claude/worktrees) is accepted too.
    const wt = path.join(projectDir, '.claude', 'worktrees', 'feat')
    const wtRes = await post(`/api/${slug}/tasks/${task.id}/cwd`, { cwd: wt })
    expect(wtRes.status).toBe(200)
    expect(await readTaskField(task.id, 'cwd')).toBe(wt)

    // A wandered /tmp path is rejected, and the last good cwd stays put.
    const tmpRes = await post(`/api/${slug}/tasks/${task.id}/cwd`, { cwd: '/tmp' })
    expect(tmpRes.status).toBe(400)
    expect(await tmpRes.json()).toEqual({
      error: 'cwd must be under the project root',
    })
    expect(await readTaskField(task.id, 'cwd')).toBe(wt)
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

describe('attachments', () => {
  async function upload(
    files: { name: string; type: string; bytes: Uint8Array }[],
    headers: Record<string, string> = { 'x-lander-ui-token': UI_TOKEN },
  ): Promise<Response> {
    const fd = new FormData()
    for (const f of files)
      fd.append(
        'file',
        new File([f.bytes as BlobPart], f.name, { type: f.type }),
      )
    return app.request(`/api/${slug}/attachments`, {
      method: 'POST',
      headers,
      body: fd,
    })
  }

  it('uploads a file and streams it back with its mime', async () => {
    const bytes = new TextEncoder().encode('a,b\n1,2\n')
    const res = await upload([{ name: 'data.csv', type: 'text/csv', bytes }])
    expect(res.status).toBe(201)
    const { attachments } = (await res.json()) as {
      attachments: { id: string; name: string; mime: string; size: number }[]
    }
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      name: 'data.csv',
      mime: 'text/csv',
      size: bytes.byteLength,
    })

    const dl = await app.request(
      `/api/${slug}/attachments/${attachments[0].id}`,
      { headers: { 'x-lander-ui-token': UI_TOKEN } },
    )
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-type')).toBe('text/csv')
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(bytes)
  })

  it('accepts several files in one upload', async () => {
    const res = await upload([
      { name: 'a.txt', type: 'text/plain', bytes: new Uint8Array([1]) },
      { name: 'b.txt', type: 'text/plain', bytes: new Uint8Array([2, 3]) },
    ])
    const { attachments } = (await res.json()) as { attachments: unknown[] }
    expect(attachments).toHaveLength(2)
  })

  it('rejects an anonymous upload', async () => {
    const res = await upload(
      [{ name: 'x', type: 'text/plain', bytes: new Uint8Array([1]) }],
      {},
    )
    expect(res.status).toBe(403)
  })

  it('rejects an anonymous download', async () => {
    const { attachments } = (await (
      await upload([{ name: 'x', type: 'text/plain', bytes: new Uint8Array([1]) }])
    ).json()) as { attachments: { id: string }[] }
    const res = await app.request(
      `/api/${slug}/attachments/${attachments[0].id}`,
    )
    expect(res.status).toBe(403)
  })

  it('404s an unknown attachment id', async () => {
    const res = await app.request(`/api/${slug}/attachments/nope`, {
      headers: { 'x-lander-ui-token': UI_TOKEN },
    })
    expect(res.status).toBe(404)
  })

  it('associates uploaded attachments with a deferred message (no drive)', async () => {
    const { attachments } = (await (
      await upload([{ name: 'p.png', type: 'image/png', bytes: new Uint8Array([1, 2]) }])
    ).json()) as { attachments: { id: string }[] }

    // Seed a resting task so the send has a target and doesn't need a daemon.
    const restingId = 'resting-attach-task'
    await writeFile(
      path.join(tasksDir, `${restingId}.json`),
      JSON.stringify(
        {
          id: restingId,
          title: 'Resting',
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

    // A deferred send (has --date) stashes the message without driving a run.
    const res = await post(`/api/${slug}/tasks/${restingId}/messages`, {
      message: 'look at this',
      date: '2999-01-01T00:00:00.000Z',
      attachments: attachments.map((a) => a.id),
    })
    expect(res.status).toBe(200)
    const raw = JSON.parse(
      await readFile(path.join(tasksDir, `${restingId}.json`), 'utf8'),
    )
    expect(raw.scheduledMessages[0].attachments).toHaveLength(1)
    expect(raw.scheduledMessages[0].attachments[0].id).toBe(attachments[0].id)
  })

  it('rejects a task created with an unknown attachment id', async () => {
    const res = await post(`/api/${slug}/tasks`, {
      title: 'bad',
      message: 'hi',
      attachments: ['no-such-id'],
    })
    expect(res.status).toBe(400)
  })
})

describe('artifacts', () => {
  const attachmentsDir = () => path.join(dataRoot, 'attachments')

  // Seed a task on disk with a token and a pending assistant message, so a
  // publish has a slot owner and a generating message to attach the ref to.
  async function seedTask(
    id: string,
    over: Record<string, unknown> = {},
  ): Promise<void> {
    await writeFile(
      path.join(tasksDir, `${id}.json`),
      JSON.stringify(
        {
          id,
          title: 'Artifact task',
          status: 'riding',
          createdAt: AT,
          updatedAt: AT,
          allowEdits: false,
          token: `token-${id}`,
          runId: `run-${id}`,
          shape: 2,
          // A live turn: the open ride the publish lands its artifact ref on.
          rides: [{ id: `run-${id}`, startedAt: AT }],
          items: [
            { id: 'u0', at: AT, kind: 'message', role: 'user', text: 'make a file' },
            {
              id: 'f0',
              at: AT,
              rideId: `run-${id}`,
              kind: 'message',
              role: 'flow',
              text: 'working',
            },
          ],
          ...over,
        },
        null,
        2,
      ),
    )
  }

  async function publish(
    id: string,
    file: { name: string; type: string; bytes: Uint8Array },
    opts: { name?: string; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const fd = new FormData()
    fd.append('file', new File([file.bytes as BlobPart], file.name, { type: file.type }))
    if (opts.name) fd.append('name', opts.name)
    return app.request(`/api/${slug}/tasks/${id}/artifacts`, {
      method: 'POST',
      headers: opts.headers ?? { 'x-lander-ui-token': UI_TOKEN },
      body: fd,
    })
  }

  it('publishes a slot, records the message ref, and streams it back by name', async () => {
    const id = 'artifact-basic'
    await seedTask(id)
    const bytes = new TextEncoder().encode('hello output')
    const res = await publish(id, { name: 'out.txt', type: 'text/plain', bytes })
    expect(res.status).toBe(201)
    const { artifact } = (await res.json()) as {
      artifact: { name: string; id: string; size: number }
    }
    expect(artifact).toMatchObject({ name: 'out.txt', size: bytes.byteLength })

    const raw = JSON.parse(
      await readFile(path.join(tasksDir, `${id}.json`), 'utf8'),
    )
    expect(raw.artifacts).toHaveLength(1)
    expect(raw.artifacts[0].name).toBe('out.txt')
    // The ref lands on the open ride's flow message item.
    const flow = (raw.items as { role?: string; artifacts?: { name: string }[] }[]).find(
      (i) => i.role === 'flow' && i.artifacts,
    )!
    expect(flow.artifacts).toHaveLength(1)
    expect(flow.artifacts![0].name).toBe('out.txt')

    const dl = await app.request(`/api/${slug}/tasks/${id}/artifacts/out.txt`, {
      headers: { 'x-lander-ui-token': UI_TOKEN },
    })
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-type')).toBe('text/plain')
    expect(dl.headers.get('content-disposition')).toBe(
      'attachment; filename="out.txt"',
    )
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(bytes)
  })

  it('republishing a name replaces the blob, leaving exactly one blob for the slot', async () => {
    const id = 'artifact-replace'
    await seedTask(id)
    await publish(id, { name: 'r.txt', type: 'text/plain', bytes: new Uint8Array([1]) })
    const first = JSON.parse(
      await readFile(path.join(tasksDir, `${id}.json`), 'utf8'),
    )
    const firstBlob = first.artifacts[0].id

    const res = await publish(id, {
      name: 'r.txt',
      type: 'text/plain',
      bytes: new Uint8Array([2, 2, 2]),
    })
    expect(res.status).toBe(201)
    const raw = JSON.parse(
      await readFile(path.join(tasksDir, `${id}.json`), 'utf8'),
    )
    // Still one slot, pointing at a fresh blob, createdAt preserved.
    expect(raw.artifacts).toHaveLength(1)
    expect(raw.artifacts[0].id).not.toBe(firstBlob)
    expect(raw.artifacts[0].createdAt).toBe(first.artifacts[0].createdAt)
    expect(raw.artifacts[0].size).toBe(3)
    // The generating flow item keeps a single ref for the name (updated in place),
    // not a second stale chip from the republish.
    const flow = (raw.items as { role?: string; artifacts?: { id: string }[] }[]).find(
      (i) => i.role === 'flow' && i.artifacts,
    )!
    expect(flow.artifacts).toHaveLength(1)
    expect(flow.artifacts![0].id).toBe(raw.artifacts[0].id)

    // The superseded blob (+ sidecar) is gone: only the current one remains.
    const entries = await readdir(attachmentsDir())
    expect(entries).not.toContain(firstBlob)
    expect(entries).toContain(raw.artifacts[0].id)
    // Download serves the latest bytes.
    const dl = await app.request(`/api/${slug}/tasks/${id}/artifacts/r.txt`, {
      headers: { 'x-lander-ui-token': UI_TOKEN },
    })
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(new Uint8Array([2, 2, 2]))
  })

  it('lets the task itself publish with its token but rejects another task and anon', async () => {
    const id = 'artifact-auth'
    await seedTask(id)
    const own = { 'x-lander-task': id, 'x-lander-project': slug, 'x-lander-token': `token-${id}` }
    const mine = await publish(
      id,
      { name: 'o.txt', type: 'text/plain', bytes: new Uint8Array([1]) },
      { headers: own },
    )
    expect(mine.status).toBe(201)

    // A different task's (valid) credentials can't publish here.
    await seedTask('artifact-other')
    const other = {
      'x-lander-task': 'artifact-other',
      'x-lander-project': slug,
      'x-lander-token': 'token-artifact-other',
    }
    const foreign = await publish(
      id,
      { name: 'x.txt', type: 'text/plain', bytes: new Uint8Array([1]) },
      { headers: other },
    )
    expect(foreign.status).toBe(403)

    const anon = await publish(
      id,
      { name: 'x.txt', type: 'text/plain', bytes: new Uint8Array([1]) },
      { headers: {} },
    )
    expect(anon.status).toBe(403)
  })

  it('rejects an unsafe artifact name that survives sanitization', async () => {
    const id = 'artifact-badname'
    await seedTask(id)
    // A leading dot and an embedded space both clear sanitizeName (which only
    // strips directory components + control chars) but fail the strict name regex.
    for (const name of ['.hidden', 'bad name']) {
      const res = await publish(
        id,
        { name: 'out.txt', type: 'text/plain', bytes: new Uint8Array([1]) },
        { name },
      )
      expect(res.status).toBe(400)
    }
  })

  it('lists slots and 404s an unknown name', async () => {
    const id = 'artifact-list'
    await seedTask(id)
    await publish(id, { name: 'a.txt', type: 'text/plain', bytes: new Uint8Array([1]) })
    const list = await app.request(`/api/${slug}/tasks/${id}/artifacts`, {
      headers: { 'x-lander-ui-token': UI_TOKEN },
    })
    expect(list.status).toBe(200)
    const { artifacts } = (await list.json()) as { artifacts: { name: string }[] }
    expect(artifacts.map((a) => a.name)).toEqual(['a.txt'])

    const missing = await app.request(`/api/${slug}/tasks/${id}/artifacts/nope`, {
      headers: { 'x-lander-ui-token': UI_TOKEN },
    })
    expect(missing.status).toBe(404)
  })
})

describe('asks', () => {
  type Raw = Record<string, unknown>
  const taskFile = (id: string) => path.join(tasksDir, `${id}.json`)
  const readRaw = async (id: string): Promise<Raw> =>
    JSON.parse(await readFile(taskFile(id), 'utf8'))
  // Storage is the v2 item log now; project the ask/event/user-message items out
  // for assertions that used to read the parallel asks[]/events[]/messages[].
  const asksOf = (raw: Raw): Raw[] =>
    ((raw.items as Raw[]) ?? []).filter((i) => i.kind === 'ask')
  const eventsOf = (raw: Raw): Raw[] =>
    ((raw.items as Raw[]) ?? []).filter((i) => i.kind === 'event')
  const userMsgsOf = (raw: Raw): Raw[] =>
    ((raw.items as Raw[]) ?? []).filter(
      (i) => i.kind === 'message' && (i as Raw).role === 'user',
    )

  // Seed a wedged task on disk with a token, so a create/answer has an owner and
  // (for answer tests) an ask already open. Ask fixtures are written in the
  // ask-payload form (`asks: [openAsk()]`) for readability and folded here into
  // the ask items storage actually holds.
  async function seedTask(id: string, over: Raw = {}): Promise<void> {
    const { asks, items, ...rest } = over as Raw & { asks?: Raw[]; items?: Raw[] }
    const askItems = (asks ?? []).map(({ createdAt, ...ask }) => ({
      ...ask,
      at: createdAt,
      kind: 'ask',
    }))
    await writeFile(
      taskFile(id),
      JSON.stringify(
        {
          id,
          title: 'Ask task',
          status: 'riding',
          createdAt: AT,
          updatedAt: AT,
          allowEdits: false,
          token: `token-${id}`,
          shape: 2,
          rides: [],
          ...rest,
          items: [
            ...(items ?? [
              { id: 'u0', at: AT, kind: 'message', role: 'user', text: 'go' },
            ]),
            ...askItems,
          ],
        },
        null,
        2,
      ),
    )
  }

  const choiceForm = {
    type: 'choice',
    options: [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Beta' },
    ],
  }

  const openAsk = (over: Raw = {}) => ({
    id: 'ask-seed-0',
    createdAt: AT,
    prompt: 'Pick one',
    form: choiceForm,
    blocking: 'task',
    state: 'open',
    ...over,
  })

  const headers = (h: Record<string, string>) => ({
    'content-type': 'application/json',
    ...h,
  })
  const taskAuth = (id: string) => ({
    'x-lander-task': id,
    'x-lander-project': slug,
    'x-lander-token': `token-${id}`,
  })

  async function create(
    id: string,
    body: unknown,
    h: Record<string, string> = { 'x-lander-ui-token': UI_TOKEN },
  ): Promise<Response> {
    return app.request(`/api/${slug}/tasks/${id}/asks`, {
      method: 'POST',
      headers: headers(h),
      body: JSON.stringify(body),
    })
  }

  async function answer(
    id: string,
    askId: string,
    body: unknown,
    h: Record<string, string> = { 'x-lander-ui-token': UI_TOKEN },
  ): Promise<Response> {
    return app.request(`/api/${slug}/tasks/${id}/asks/${askId}/answer`, {
      method: 'POST',
      headers: headers(h),
      body: JSON.stringify(body),
    })
  }

  it('creates a task-blocking ask, wedging the task in the same write', async () => {
    const id = 'ask-create'
    await seedTask(id)
    const res = await create(id, { prompt: 'Deploy?', form: choiceForm })
    expect(res.status).toBe(201)
    const { ask } = (await res.json()) as { ask: { id: string; state: string } }
    expect(ask.state).toBe('open')

    const raw = await readRaw(id)
    expect(raw.status).toBe('wedged')
    expect(asksOf(raw).map((a) => a.id)).toEqual([ask.id])
    // The wedge crossing is recorded so it surfaces in the timeline.
    expect(eventsOf(raw).some((e) => e.eventKind === 'wedged')).toBe(true)
  })

  it('lets the task itself raise its ask but rejects a foreign task and anon', async () => {
    const id = 'ask-create-auth'
    await seedTask(id)
    const mine = await create(id, { prompt: 'p', form: choiceForm }, taskAuth(id))
    expect(mine.status).toBe(201)

    await seedTask('ask-other')
    const foreign = await create(
      id,
      { prompt: 'p', form: choiceForm },
      taskAuth('ask-other'),
    )
    expect(foreign.status).toBe(403)
    const anon = await create(id, { prompt: 'p', form: choiceForm }, {})
    expect(anon.status).toBe(403)
  })

  it('creates a promptless ask (the agent message is the question)', async () => {
    const id = 'ask-create-noprompt'
    await seedTask(id)
    const res = await create(id, { form: choiceForm })
    expect(res.status).toBe(201)
    const { ask } = (await res.json()) as { ask: { prompt?: string } }
    expect(ask.prompt).toBeUndefined()
    const raw = await readRaw(id)
    expect(raw.status).toBe('wedged')
  })

  it('anchors the ask to the open ride, even when an earlier ride wrote the last prose', async () => {
    // The regression case: a wedge raised before its own turn streams any prose
    // must anchor to the ride that raised it, not to a stale message from a
    // previous turn (where the form would render in the wrong bubble).
    const id = 'ask-create-anchor'
    await seedTask(id, {
      shape: 2,
      items: [
        {
          id: 'old-prose',
          at: AT,
          rideId: 'ride-old',
          kind: 'message',
          role: 'flow',
          text: 'earlier turn',
        },
      ],
      rides: [
        { id: 'ride-old', startedAt: AT, endedAt: AT, outcome: 'done' },
        { id: 'ride-live', startedAt: AT },
      ],
    })
    expect((await create(id, { form: choiceForm })).status).toBe(201)
    const item = asksOf(await readRaw(id))[0]
    expect(item.rideId).toBe('ride-live')
    expect(item.parentId).toBeUndefined()
  })

  it('leaves an ask raised with no ride in flight unanchored', async () => {
    const id = 'ask-create-no-ride'
    await seedTask(id, { shape: 2, items: [], rides: [] })
    expect((await create(id, { form: choiceForm })).status).toBe(201)
    expect(asksOf(await readRaw(id))[0].rideId).toBeUndefined()
  })

  it('400s a malformed form or an unimplemented blocking level', async () => {
    const id = 'ask-create-valid'
    await seedTask(id)
    expect(
      (await create(id, { form: { type: 'choice', options: [] } })).status,
    ).toBe(400)
    const ride = await create(id, { form: choiceForm, blocking: 'ride' })
    expect(ride.status).toBe(400)
    expect(((await ride.json()) as { error: string }).error).toMatch(/not implemented/)
  })

  it('creates an advisory (blocking:none) ask without wedging', async () => {
    const id = 'ask-create-none'
    await seedTask(id) // default status: 'riding'
    const res = await create(id, { form: choiceForm, blocking: 'none' })
    expect(res.status).toBe(201)
    const { ask } = (await res.json()) as {
      ask: { blocking: string; state: string }
    }
    expect(ask).toMatchObject({ blocking: 'none', state: 'open' })
    const raw = await readRaw(id)
    // No status transition — the task rests with the question attached, and the
    // wedge crossing that a task-blocking ask records is absent.
    expect(raw.status).toBe('riding')
    expect(eventsOf(raw).some((e) => e.eventKind === 'wedged')).toBe(false)
  })

  it('withdraws the prior open ask when a fresh one supersedes it (last-in-turn wins)', async () => {
    const id = 'ask-create-supersede'
    await seedTask(id, { status: 'wedged', asks: [openAsk()] })
    const res = await create(id, { form: choiceForm, blocking: 'none' })
    expect(res.status).toBe(201)
    const asks = asksOf(await readRaw(id))
    // The seeded ask is withdrawn; only the fresh one stays open — at most one
    // open ask, so the UI's single-open-ask finder still holds.
    expect(asks).toHaveLength(2)
    expect(asks[0].state).toBe('withdrawn')
    expect(asks[1].state).toBe('open')
    expect(asks.filter((a) => a.state === 'open')).toHaveLength(1)
  })

  it('answers an advisory ask: delivers the bare value, delivery queued to ride', async () => {
    const id = 'ask-answer-none'
    await seedTask(id, {
      status: 'resting',
      // Promptless (the agent message was the question), like an agent wedge.
      asks: [openAsk({ blocking: 'none', prompt: undefined })],
    })
    const res = await answer(id, 'ask-seed-0', { optionId: 'b' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; items: Raw[] }
    // Stored `riding` with no open ride (no daemon in-test to start one) serves as
    // `resting`; the queued delivery below rides it as soon as a daemon picks it up.
    expect(body.status).toBe('resting')
    const asks = body.items.filter((it) => it.kind === 'ask')
    expect(asks[0].state).toBe('answered')
    // A promptless ask delivers the bare chosen label as the next user message.
    const userItems = body.items.filter(
      (it) => it.kind === 'message' && it.role === 'user',
    )
    expect(userItems[userItems.length - 1]).toMatchObject({
      role: 'user',
      text: 'Beta',
    })
  })

  it('answers immediately: un-wedges, queues the delivery, marks the ask answered', async () => {
    const id = 'ask-answer'
    await seedTask(id, { status: 'wedged', asks: [openAsk()] })
    const res = await answer(id, 'ask-seed-0', { optionId: 'b' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; items: Raw[] }
    // Un-wedges to stored `riding`; with no open ride yet (no daemon in-test) that
    // serves as `resting`, and the queued delivery rides once a daemon picks it up.
    expect(body.status).toBe('resting')
    const asks = body.items.filter((it) => it.kind === 'ask')
    expect(asks[0].state).toBe('answered')
    // The delivery is appended as a queued user message carrying the chosen label.
    const userItems = body.items.filter(
      (it) => it.kind === 'message' && it.role === 'user',
    )
    const last = userItems[userItems.length - 1]
    expect(last).toMatchObject({
      role: 'user',
      text: 'Answer to "Pick one": Beta',
      queued: true,
    })
  })

  it('answers with a future-at option: stays wedged and schedules the delivery', async () => {
    const id = 'ask-answer-sched'
    const resetsAt = '2099-01-01T00:00:00.000Z'
    await seedTask(id, {
      status: 'wedged',
      asks: [
        openAsk({
          form: {
            type: 'choice',
            options: [
              { id: 'now', label: 'Now' },
              { id: 'later', label: 'Later', at: resetsAt },
            ],
          },
        }),
      ],
    })
    const res = await answer(id, 'ask-seed-0', { optionId: 'later' })
    expect(res.status).toBe(200)
    const raw = await readRaw(id)
    // Stays wedged, with a scheduled wakeup and the delivery queued for it.
    expect(raw.status).toBe('wedged')
    expect(raw.scheduledFor).toBe(resetsAt)
    expect(eventsOf(raw).some((e) => e.eventKind === 'scheduled')).toBe(true)
    expect(raw.queued).toEqual(['Answer to "Pick one": Later'])
    expect(asksOf(raw)[0].state).toBe('answered')
  })

  it('gates answering to the UI, 404s an unknown ask, and 409s a non-open one', async () => {
    const id = 'ask-answer-auth'
    await seedTask(id, { status: 'wedged', asks: [openAsk()] })
    const asTask = await answer(id, 'ask-seed-0', { optionId: 'a' }, taskAuth(id))
    expect(asTask.status).toBe(403)

    expect((await answer(id, 'nope', { optionId: 'a' })).status).toBe(404)

    expect((await answer(id, 'ask-seed-0', { optionId: 'a' })).status).toBe(200)
    // Already answered → 409.
    expect((await answer(id, 'ask-seed-0', { optionId: 'a' })).status).toBe(409)
  })

  it('withdraws an open ask when a fresh message supersedes it', async () => {
    const id = 'ask-withdraw-msg'
    await seedTask(id, { status: 'wedged', asks: [openAsk()] })
    const res = await post(`/api/${slug}/tasks/${id}/messages`, {
      message: 'never mind, do this instead',
    })
    expect(res.status).toBe(200)
    const raw = await readRaw(id)
    expect(asksOf(raw)[0].state).toBe('withdrawn')
    expect(raw.status).toBe('riding')
  })

  it('withdraws an open ask when the task is manually moved off wedged', async () => {
    const id = 'ask-withdraw-patch'
    await seedTask(id, { status: 'wedged', asks: [openAsk()] })
    const res = await app.request(`/api/${slug}/tasks/${id}`, {
      method: 'PATCH',
      headers: headers({ 'x-lander-ui-token': UI_TOKEN }),
      body: JSON.stringify({ status: 'landed' }),
    })
    expect(res.status).toBe(200)
    const raw = await readRaw(id)
    expect(asksOf(raw)[0].state).toBe('withdrawn')
  })

  // A task can rest with a wakeup armed and *then* wedge (a platform kill, an
  // assistant error) before it fires. The wakeup resumes the task by its own
  // route, so the ask it left open is moot — it must not linger over the resumed
  // conversation.
  it('withdraws an open ask when a scheduled wakeup resumes the task', async () => {
    const id = 'ask-withdraw-launch'
    await seedTask(id, {
      status: 'wedged',
      scheduledFor: AT,
      // A turn already ran (a settled ride), so the wakeup drives the synthetic
      // resume prompt rather than a queued opening message — the `lander rest`
      // path, not a deferred `new`.
      rides: [{ id: 'r0', startedAt: AT, endedAt: AT, outcome: 'done' }],
      items: [
        { id: 'u0', at: AT, kind: 'message', role: 'user', text: 'go' },
        { id: 'f0', at: AT, rideId: 'r0', kind: 'message', role: 'flow', text: 'on it' },
      ],
      asks: [openAsk()],
    })
    const res = await post(`/api/${slug}/tasks/${id}/launch`, {})
    expect(res.status).toBe(200)
    const raw = await readRaw(id)
    expect(asksOf(raw)[0].state).toBe('withdrawn')
    expect(raw.status).toBe('riding')
    // The wakeup still drives its synthetic resume prompt — withdrawing the ask
    // doesn't swallow the turn the launch exists to start.
    expect(userMsgsOf(raw).at(-1)!.text).toMatch(/^Resumed at /)
  })

  // Withdrawal rides on the status crossing (recordStatusTransition, unit-tested
  // in tasks.test.ts), so it reaches paths that never call withdrawOpenAsks
  // themselves. `rest` from a wedge is one that used to miss it.
  it('withdraws an open ask when a wedged task rests', async () => {
    const id = 'ask-withdraw-rest'
    await seedTask(id, { status: 'wedged', asks: [openAsk()] })
    const res = await post(`/api/${slug}/tasks/${id}/rest`, { time: 30 })
    expect(res.status).toBe(200)
    const raw = await readRaw(id)
    expect(asksOf(raw)[0].state).toBe('withdrawn')
  })

  // The mirror image: an advisory `lander ask` never wedged, so resting with the
  // question still up is the whole point of it — no crossing, no withdrawal.
  it('keeps an advisory ask open when a riding task rests', async () => {
    const id = 'ask-advisory-rest'
    await seedTask(id, {
      status: 'riding',
      asks: [openAsk({ blocking: 'none' })],
    })
    const res = await post(`/api/${slug}/tasks/${id}/rest`, { time: 30 })
    expect(res.status).toBe(200)
    const raw = await readRaw(id)
    expect(asksOf(raw)[0].state).toBe('open')
  })

  it('withdraws an open ask when the task is relaunched', async () => {
    const id = 'ask-withdraw-relaunch'
    await seedTask(id, { status: 'wedged', asks: [openAsk()] })
    const res = await post(`/api/${slug}/tasks/${id}/relaunch`, {
      message: 'start over',
    })
    expect(res.status).toBe(200)
    const raw = await readRaw(id)
    expect(asksOf(raw)[0].state).toBe('withdrawn')
  })

  // A platform retry ask (origin:'retry') routes the answer through the
  // retry-recovery machinery instead of a generic delivery.
  const retryAsk = (over: Raw = {}) => ({
    id: 'ask-retry-0',
    createdAt: AT,
    prompt: 'The assistant run failed.',
    form: { type: 'choice', options: [{ id: 'retry-now', label: 'Try again' }] },
    blocking: 'task',
    state: 'open',
    origin: 'retry',
    ...over,
  })

  it('answers retry-now on a committed wedge: nudges the session and un-wedges', async () => {
    const id = 'ask-retry-committed'
    await seedTask(id, {
      status: 'wedged',
      retry: { committed: true, prompts: ['do the thing'] },
      asks: [retryAsk()],
    })
    const res = await answer(id, 'ask-retry-0', { optionId: 'retry-now' })
    expect(res.status).toBe(200)
    const raw = await readRaw(id)
    expect(raw.status).toBe('riding')
    // Committed → a "try again" nudge (re-sending would duplicate the turn).
    expect(raw.queued).toEqual(['try again'])
    expect(raw.retry).toBeUndefined()
    expect(asksOf(raw)[0].state).toBe('answered')
    // No generic "Answer to …" delivery message for a retry ask.
    const texts = userMsgsOf(raw).map((m) => m.text as string)
    expect(texts.some((t) => t.startsWith('Answer to'))).toBe(false)
  })

  it('answers retry-now on an uncommitted wedge: re-sends the un-received prompts', async () => {
    const id = 'ask-retry-resend'
    await seedTask(id, {
      status: 'wedged',
      retry: { committed: false, prompts: ['first', 'second'] },
      asks: [retryAsk({ form: { type: 'choice', options: [{ id: 'retry-now', label: 'Resend' }] } })],
    })
    const res = await answer(id, 'ask-retry-0', { optionId: 'retry-now' })
    expect(res.status).toBe(200)
    const raw = await readRaw(id)
    expect(raw.status).toBe('riding')
    // Not committed → re-queue the exact prompts (already in messages[]).
    expect(raw.queued).toEqual(['first', 'second'])
  })

  it('answers retry-at-reset: stays wedged and schedules the recovery for the reset', async () => {
    const id = 'ask-retry-deferred'
    const resetsAt = '2099-01-01T00:00:00.000Z'
    await seedTask(id, {
      status: 'wedged',
      retry: { committed: true, prompts: ['do it'], resetsAt },
      asks: [
        retryAsk({
          prompt: 'Usage limit reached.',
          form: {
            type: 'choice',
            options: [
              { id: 'retry-now', label: 'Retry now' },
              {
                id: 'retry-at-reset',
                label: 'Retry when the limit resets',
                at: resetsAt,
                style: 'primary',
              },
            ],
          },
        }),
      ],
    })
    const res = await answer(id, 'ask-retry-0', { optionId: 'retry-at-reset' })
    expect(res.status).toBe(200)
    const raw = await readRaw(id)
    // Stays wedged, schedules the wakeup, queues the recovery for it.
    expect(raw.status).toBe('wedged')
    expect(raw.scheduledFor).toBe(resetsAt)
    expect(raw.queued).toEqual(['try again'])
    expect(eventsOf(raw).some((e) => e.eventKind === 'scheduled')).toBe(true)
    expect(asksOf(raw)[0].state).toBe('answered')
  })
})

// Landing is terminal, so any wakeup the task was still holding can only bring a
// finished task back to report it has nothing to do. Both observed halves of the
// problem meet here: every one of the recorded spurious resumes fired on a task
// that had ALREADY landed, and the scheduler will happily launch a landed task
// even though the daemon's wake-delivery table answers one with "ack and drop".
describe('landing disarms the task’s wakeups', () => {
  const taskFile = (id: string) => path.join(tasksDir, `${id}.json`)
  const readRaw = async (id: string): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(taskFile(id), 'utf8'))
  const patch = (id: string, body: unknown) =>
    app.request(`/api/${slug}/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-lander-ui-token': UI_TOKEN },
      body: JSON.stringify(body),
    })

  const seedArmed = (id: string) =>
    writeFile(
      taskFile(id),
      JSON.stringify({
        id,
        title: 'Resting task',
        status: 'riding',
        // Overdue on purpose: the trigger is one scheduler sweep away from
        // firing, which is exactly the state the seven observed cases were in.
        scheduledFor: AT,
        waitingFor: ['sibling-x'],
        createdAt: AT,
        updatedAt: AT,
        allowEdits: false,
        shape: 2,
        items: [],
        rides: [{ id: 'r0', startedAt: AT, endedAt: AT, outcome: 'done' }],
      }),
    )

  it('drops both triggers, so the wakeup can no longer launch it', async () => {
    const id = 'land-disarms'
    await seedArmed(id)
    expect((await patch(id, { status: 'landed' })).status).toBe(200)

    const raw = await readRaw(id)
    expect(raw.status).toBe('landed')
    expect(raw.scheduledFor).toBeUndefined()
    expect(raw.waitingFor).toBeUndefined()

    // The scheduler's own gate: nothing armed, nothing to launch. Before this
    // it would have driven a full "Resumed at …" ride on a landed task.
    const launch = await post(`/api/${slug}/tasks/${id}/launch`, {})
    expect(launch.status).toBe(409)
  })

  it('still un-lands, just with nothing stale left to fire', async () => {
    const id = 'land-disarms-unland'
    await seedArmed(id)
    expect((await patch(id, { status: 'landed' })).status).toBe(200)
    expect((await patch(id, { status: 'riding' })).status).toBe(200)

    const raw = await readRaw(id)
    expect(raw.status).toBe('riding')
    expect(
      ((raw.items as Record<string, unknown>[]) ?? [])
        .filter((i) => i.kind === 'event')
        .map((i) => i.eventKind),
    ).toEqual(['landed', 'unlanded'])
    expect(raw.scheduledFor).toBeUndefined()
    expect(raw.waitingFor).toBeUndefined()
  })
})

// A daemon that dies mid-turn (a supervisor max-drain SIGTERM, a crash) can't
// settle its own runs; the server crashes the abandoned run once the reconnect
// grace lapses. That platform kill must wedge the task with a retry ask — not
// leave it silently resting like an interrupt would. Driven end to end over a real
// attachDaemonServer with a fake daemon that HOLDS runs open (never sends a done),
// so the only way its run ends is a crash. A user interrupt (the status PATCH
// path) must keep its no-ask semantics.
describe('platform-kill wedge (daemon vanishes mid-run)', () => {
  let http: Server
  let ws: WebSocket
  const received: { type: string; runId?: string; taskId?: string; project?: string }[] = []
  // The platform-kill retry ask's prompt (index.ts PLATFORM_KILL_PROMPT) and error
  // line — pinned here as the user-facing contract. The prompt states the kill
  // rather than asking about it: the options are the question, and the prompt
  // stays behind as the record once they're gone.
  const KILL_PROMPT =
    'This ride was killed by a daemon update while work was in flight.'
  const KILL_ERROR =
    'error running assistant: the daemon running this task stopped before the turn finished'
  // When true, the fake daemon answers an interrupt with a clean interrupted done,
  // mirroring the real daemon's SIGKILL → done{interrupted:true}. Off during the
  // crash test (which ends the run by disconnecting, not interrupting).
  let answerInterrupt = false

  type Raw = Record<string, unknown>
  const waitFor = async (pred: () => boolean, ms = 3000): Promise<void> => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (pred()) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('waitFor timed out')
  }
  const readRaw = async (id: string): Promise<Raw> =>
    JSON.parse(await readFile(path.join(tasksDir, `${id}.json`), 'utf8'))
  // Poll the persisted task file until `pred` holds (real timers only).
  const waitForRaw = async (
    id: string,
    pred: (raw: Raw) => boolean,
    ms = 3000,
  ): Promise<Raw> => {
    const start = Date.now()
    let last: Raw | undefined
    while (Date.now() - start < ms) {
      last = await readRaw(id)
      if (pred(last)) return last
      await new Promise((r) => setTimeout(r, 10))
    }
    // Say what the task actually looked like: "timed out" alone can't distinguish
    // "the state never arrived" from "it arrived in a shape the predicate didn't
    // match", and those want opposite fixes.
    throw new Error(
      `waitForRaw timed out after ${ms}ms; last saw ` +
        `status=${String(last?.status)} runId=${String(last?.runId)} ` +
        `retry=${JSON.stringify(last?.retry)}`,
    )
  }
  const asksOf = (raw: Raw): Raw[] =>
    ((raw.items as Raw[]) ?? []).filter((i) => i.kind === 'ask')
  const startRuns = (id: string) =>
    received.filter((m) => m.type === 'start-run' && m.taskId === id)

  async function seed(id: string): Promise<void> {
    await writeFile(
      path.join(tasksDir, `${id}.json`),
      JSON.stringify({
        id,
        title: 'Kill task',
        status: 'riding',
        createdAt: AT,
        updatedAt: AT,
        allowEdits: false,
        shape: 2,
        items: [],
        rides: [],
      }),
    )
  }

  // Connect (or reconnect) the fake daemon and wait until the server routes this
  // project's runs to it. Called once up front, and again by the tests that end by
  // disconnecting it to stage a crash.
  async function connectDaemon(): Promise<void> {
    const port = (http.address() as AddressInfo).port
    ws = new WebSocket(`ws://localhost:${port}/daemon?token=${UI_TOKEN}`)
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject)
      ws.on('open', () => resolve())
    })
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString()) as {
        type: string
        runId?: string
        taskId?: string
        project?: string
      }
      received.push(msg)
      // Runs are held open (no done for start-run). Only interrupts get a reply,
      // and only when the current test opts in.
      if (msg.type === 'interrupt' && answerInterrupt)
        ws.send(
          JSON.stringify({
            type: 'done',
            runId: msg.runId,
            exitCode: 0,
            interrupted: true,
            stderr: '',
          }),
        )
    })
    ws.send(
      JSON.stringify({ type: 'register', projects: [{ slug }], draining: false, runs: [] }),
    )
    // The register handler records the slugs we serve — its landing confirms the
    // server routes this project's runs to us.
    await waitFor(() => daemonServes(slug))
  }

  // Disconnect the daemon and expire the reconnect grace, so the server gives up
  // on the run it abandoned and crashes it. Only setTimeout is faked, so real
  // WS/fs I/O still flows and setImmediate stays a genuine event-loop yield.
  async function killDaemon(): Promise<void> {
    // Fake timers go in FIRST and stay in: the grace timer has to be armed while
    // they're installed for advanceTimersByTime to reach it. A timer already
    // scheduled on the real clock would just sit there.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    ws.close()
    // Yield real I/O ticks until the server has registered the disconnect and
    // armed that timer. Bound this by the wall clock rather than by a tick count:
    // a fixed budget buys less and less real time as the suite gets busier, and
    // exhausting it here used to fall through silently — the grace timer would
    // then be armed *after* we stopped faking, so it never fired, and the failure
    // surfaced downstream as the caller's own poll timing out. Only setTimeout is
    // faked, so Date.now() and setImmediate are still real.
    const deadline = Date.now() + 10_000
    while (daemonConnected() && Date.now() < deadline)
      await new Promise((r) => setImmediate(r))
    if (daemonConnected()) {
      vi.useRealTimers()
      throw new Error(
        'killDaemon: server never registered the disconnect, so the reconnect ' +
          'grace timer was never armed',
      )
    }
    // Alternate advancing with real yields instead of advancing once. The daemon
    // going away and the grace timer being armed are not the same tick: the
    // disconnect is recorded first and reconcileGrace runs behind some I/O, so a
    // single advance can land in the window before the timer exists. It would
    // then be armed on the fake clock we are about to uninstall — and a
    // fake-armed timer that never gets advanced simply never fires, which
    // surfaced as the task sitting at status=riding until the caller's poll gave
    // up. Each yield lets pending work arm its timer; each advance fires it.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(30_000)
      await new Promise((r) => setImmediate(r))
    }
    vi.useRealTimers()
  }

  beforeAll(async () => {
    await mkdir(tasksDir, { recursive: true })
    http = createServer()
    attachDaemonServer(http, { token: UI_TOKEN })
    await new Promise<void>((r) => http.listen(0, r))
    await connectDaemon()
  })

  afterAll(async () => {
    vi.useRealTimers()
    if (ws.readyState === ws.OPEN)
      await new Promise<void>((r) => {
        ws.on('close', () => r())
        ws.close()
      })
    await new Promise<void>((r) => http.close(() => r()))
  })

  // Drop each test's run channel once it's finished with it. Run channels are
  // module state shared by every suite in this file, and an open one with no live
  // owner keeps the server's reconnect-grace timer armed. That timer is armed on
  // the REAL clock, and reconcileGrace won't replace an existing one — so a
  // leaked channel from an earlier test made the next killDaemon unable to arm a
  // FAKE timer it could advance, leaving that test to wait out the real 15s
  // grace. It showed up as this suite occasionally taking 16s instead of 2.6s,
  // and as an outright failure whenever the per-test budget ran out first.
  afterEach(() => {
    for (const m of received)
      if (m.type === 'start-run' && m.runId) closeRunChannel(m.runId)
    received.length = 0
  })

  // A flow reads its durable state as a free ride-in on start-run, and its
  // producer seeds the state-patch rev counter from what comes with it. Without
  // the revision, the server's applyStatePatch guard (`rev <= flowStateRev`)
  // would silently drop every ride's writes after the first — so the revision
  // has to reach the daemon, not just the blob. Runs first, on the daemon
  // beforeAll connected: the later tests in this block disconnect it to stage a
  // crash, and connecting a second one here would orphan a socket past teardown.
  it('rides flowState and its revision in on start-run', async () => {
    const id = 'flowstate-start'
    await writeFile(
      path.join(tasksDir, `${id}.json`),
      JSON.stringify({
        id,
        title: 'Stateful task',
        status: 'idle',
        createdAt: AT,
        updatedAt: AT,
        allowEdits: false,
        shape: 2,
        items: [],
        rides: [],
        flowState: { sessionId: 'sess-kept', phase: 'reviewing' },
        flowStateRev: 4,
      }),
    )

    expect(
      (await post(`/api/${slug}/tasks/${id}/messages`, { message: 'go' })).status,
    ).toBe(200)
    await waitFor(() => startRuns(id).length === 1)

    const started = startRuns(id)[0] as unknown as {
      runId: string
      flowState?: Record<string, unknown>
      flowStateRev?: number
    }
    expect(started.flowState).toEqual({
      sessionId: 'sess-kept',
      phase: 'reviewing',
    })
    expect(started.flowStateRev).toBe(4)

    // Settle it: this suite holds runs open by default, and an unfinished run
    // keeps the server's reduce loop alive past teardown.
    ws.send(
      JSON.stringify({
        type: 'done',
        runId: started.runId,
        exitCode: 0,
        interrupted: false,
        stderr: '',
      }),
    )
    await waitForRaw(id, (r) => !r.runId)
  })

  // The revival marker is one-shot: the drain that launches the reviving turn
  // takes it under the same lock that takes the queue, so the notice rides that
  // turn and nothing after it. Also runs on the beforeAll daemon, before the
  // tests that disconnect it.
  it('rides the revival marker in on start-run, once, then clears it', async () => {
    const id = 'revived-once'
    await writeFile(
      path.join(tasksDir, `${id}.json`),
      JSON.stringify({
        id,
        title: 'Wedged task',
        status: 'wedged',
        createdAt: AT,
        updatedAt: AT,
        allowEdits: false,
        shape: 2,
        items: [],
        rides: [],
      }),
    )

    expect(
      (await post(`/api/${slug}/tasks/${id}/messages`, { message: 'go' })).status,
    ).toBe(200)
    await waitFor(() => startRuns(id).length === 1)

    const first = startRuns(id)[0] as unknown as {
      runId: string
      revived?: RevivedMarker
    }
    expect(first.revived).toEqual({ from: 'wedged' })
    // Already gone from the record by the time the run was handed over.
    expect((await readRaw(id)).revived).toBeUndefined()

    // Settle the first run, then send again: the second turn is an ordinary one.
    ws.send(
      JSON.stringify({
        type: 'done',
        runId: first.runId,
        exitCode: 0,
        interrupted: false,
        stderr: '',
      }),
    )
    await waitForRaw(id, (r) => !r.runId)

    expect(
      (await post(`/api/${slug}/tasks/${id}/messages`, { message: 'again' })).status,
    ).toBe(200)
    await waitFor(() => startRuns(id).length === 2)
    const second = startRuns(id)[1] as unknown as {
      runId: string
      revived?: RevivedMarker
    }
    expect(second.revived).toBeUndefined()

    ws.send(
      JSON.stringify({
        type: 'done',
        runId: second.runId,
        exitCode: 0,
        interrupted: false,
        stderr: '',
      }),
    )
    await waitForRaw(id, (r) => !r.runId)
  })

  // An out-of-band revival supersedes a *timer*: left armed it fires later
  // against a task that has moved on — in every case observed, one that had
  // already landed — and burns a whole ride to report there's nothing to do. An
  // await is the opposite: a real dependency on sibling tasks that an unrelated
  // message must not cancel. Same split the wake-delivery table draws for the
  // daemon path (docs/daemon-wakeups.md §Delivery).
  it('an early revival clears the rest timer, keeps the await, and says so', async () => {
    const id = 'revived-resting'
    const until = new Date(Date.now() + 3_600_000).toISOString()
    await writeFile(
      path.join(tasksDir, `${id}.json`),
      JSON.stringify({
        id,
        title: 'Resting task',
        // Stored `riding` with no open ride IS resting — the collapsed
        // vocabulary. Both triggers armed at once, which `lander rest --await
        // --time` produces and which is the only way to watch the split.
        status: 'riding',
        scheduledFor: until,
        waitingFor: ['sibling-x'],
        createdAt: AT,
        updatedAt: AT,
        allowEdits: false,
        shape: 2,
        items: [],
        rides: [{ id: 'r0', startedAt: AT, endedAt: AT, outcome: 'done' }],
      }),
    )

    expect(
      (await post(`/api/${slug}/tasks/${id}/messages`, { message: 'go' })).status,
    ).toBe(200)
    await waitFor(() => startRuns(id).length === 1)

    const run = startRuns(id)[0] as unknown as {
      runId: string
      revived?: RevivedMarker
    }
    // The notice names the time, so re-arming is one actionable step rather than
    // a guess. Formatted server-side, in the same shape as "Resumed at …".
    expect(run.revived).toEqual({ restUntil: new Date(until).toLocaleString() })

    const raw = await readRaw(id)
    expect(raw.scheduledFor).toBeUndefined()
    expect(raw.waitingFor).toEqual(['sibling-x'])

    ws.send(
      JSON.stringify({
        type: 'done',
        runId: run.runId,
        exitCode: 0,
        interrupted: false,
        stderr: '',
      }),
    )
    await waitForRaw(id, (r) => !r.runId)
  })

  // Runs before the crash test, which disconnects the shared daemon.
  it('a user PATCH interrupt wedges without a retry ask (semantics unchanged)', async () => {
    const id = 'kill-user-interrupt'
    await seed(id)
    answerInterrupt = true

    // Drive a turn; the daemon holds the run open, so the task is riding with a runId.
    expect((await post(`/api/${slug}/tasks/${id}/messages`, { message: 'go' })).status).toBe(200)
    await waitFor(() => startRuns(id).length === 1)
    // runTurn writes riding + runId before handing off the run.
    await waitForRaw(id, (raw) => !!raw.runId)

    // The human wedges the riding task from the UI: it interrupts the run, the
    // daemon answers a clean interrupted done, and the ride closes — no retry ask.
    const res = await app.request(`/api/${slug}/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-lander-ui-token': UI_TOKEN },
      body: JSON.stringify({ status: 'wedged' }),
    })
    expect(res.status).toBe(200)
    const raw = await waitForRaw(id, (r) => !r.runId)
    expect(raw.status).toBe('wedged')
    expect(raw.retry).toBeUndefined()
    expect(asksOf(raw).some((a) => a.origin === 'retry')).toBe(false)
    answerInterrupt = false
  })

  // The two tests below wait on the server's reconnect grace, and that wait is
  // usually instant but sometimes real. killDaemon fakes the clock so it can
  // expire the grace immediately — but reconcileGrace refuses to replace a timer
  // that is already armed (`if (graceTimer) return`), and an open run channel
  // with no live owner, left behind by any earlier suite in this file, keeps one
  // armed on the REAL clock. When that happens there is no fake timer to advance
  // and the grace genuinely takes its full 15 seconds.
  //
  // So both carry a budget that can absorb it. Measured: ~2.6s for the whole file
  // normally, ~16s when a stale timer forces the real wait. Trimming them back to
  // the 5s default reintroduces an intermittent failure that presents as an
  // unrelated timeout rather than as anything to do with the grace.
  it('crashes a run whose daemon vanished into a retry-ask wedge, and answering retries', async () => {
    const id = 'kill-platform'
    await seed(id)

    // Drive a turn; the daemon holds the run open (never a done).
    expect((await post(`/api/${slug}/tasks/${id}/messages`, { message: 'go' })).status).toBe(200)
    await waitFor(() => startRuns(id).length === 1)
    await waitForRaw(id, (raw) => !!raw.runId)

    // Past the grace, the run is unowned → crashed. reduceRunWs folds that in.
    await killDaemon()

    const raw = await waitForRaw(id, (r) => r.status === 'wedged', 25_000)
    expect(raw.status).toBe('wedged')
    // The ride closed as an error (a platform kill, not a user interrupt).
    expect((raw.rides as Raw[]).at(-1)?.outcome).toBe('error')
    // Nothing streamed, so the turn's ride would render blank — the error line
    // fills it (the one case that still needs it; a turn that streamed keeps its
    // text and leaves the record to the ask prompt).
    const flow = ((raw.items as Raw[]) ?? []).filter(
      (i) => i.kind === 'message' && i.role === 'flow',
    )
    expect(flow.map((i) => i.text)).toEqual([KILL_ERROR])
    // Wedged with a platform-kill retry ask naming the cause; nothing streamed, so
    // the turn is uncommitted and the ask offers a single Resend.
    const ask = asksOf(raw).find((a) => a.origin === 'retry')
    expect(ask).toBeTruthy()
    expect(ask!.prompt).toBe(KILL_PROMPT)
    expect(raw.retry).toMatchObject({ committed: false, prompts: ['go'] })

    // Answering the retry re-drives: the un-received prompt is re-queued and the
    // task goes riding (the retry stash is consumed).
    const answer = await post(
      `/api/${slug}/tasks/${id}/asks/${String(ask!.id)}/answer`,
      { optionId: 'retry-now' },
    )
    expect(answer.status).toBe(200)
    const after = await readRaw(id)
    expect(after.status).toBe('riding')
    expect(after.queued).toEqual(['go'])
    expect(after.retry).toBeUndefined()
  }, 30_000)

  // A kill that lands mid-reply leaves the streamed text standing, so there's no
  // empty turn to fill and no synthetic error line — the ask's prompt carries the
  // record on its own (buildTimeline keeps rendering it once the form is gone).
  it('leaves a mid-reply kill to the ask prompt, with no error line over the streamed text', async () => {
    const id = 'kill-streamed'
    await seed(id)
    await connectDaemon()

    expect((await post(`/api/${slug}/tasks/${id}/messages`, { message: 'go' })).status).toBe(200)
    await waitFor(() => startRuns(id).length === 1)
    const raw0 = await waitForRaw(id, (r) => !!r.runId)

    // The turn streams a partial reply, then the daemon vanishes before its done.
    ws.send(
      JSON.stringify({
        type: 'update',
        runId: String(raw0.runId),
        seq: 1,
        steps: [],
        finalText: 'partial reply',
        usageChanged: false,
      }),
    )
    await waitForRaw(id, (r) =>
      ((r.items as Raw[]) ?? []).some((i) => i.text === 'partial reply'),
    )
    await killDaemon()

    const raw = await waitForRaw(id, (r) => r.status === 'wedged', 25_000)
    // The streamed text stands alone: no error line appended over it, and none
    // written into it.
    const flow = ((raw.items as Raw[]) ?? []).filter(
      (i) => i.kind === 'message' && i.role === 'flow',
    )
    expect(flow.map((i) => i.text)).toEqual(['partial reply'])
    // Text streamed, so the turn counts as committed: the ask offers a nudge
    // rather than a re-send, and its prompt is the kill's record.
    expect(raw.retry).toMatchObject({ committed: true })
    const ask = asksOf(raw).find((a) => a.origin === 'retry')
    expect(ask!.prompt).toBe(KILL_PROMPT)
    expect((ask!.form as { options: Raw[] }).options[0].label).toBe('Try again')

    // Answering settles the form but must not erase the prompt — it's the only
    // account of the kill the conversation has.

    const answer = await post(
      `/api/${slug}/tasks/${id}/asks/${String(ask!.id)}/answer`,
      { optionId: 'retry-now' },
    )
    expect(answer.status).toBe(200)
    const settled = asksOf(await readRaw(id)).find((a) => a.origin === 'retry')!
    expect(settled.state).toBe('answered')
    expect(settled.prompt).toBe(KILL_PROMPT)
  }, 30_000)
})

// C6's dispatch gate, end to end over a real attachDaemonServer. The invariant:
// a task is never dispatched to a daemon that hasn't announced its flow. The
// failure it prevents is the silent one — a task whose flow the daemon lacks
// running as claude and executing the prompt anyway.
describe('flow dispatch gate', () => {
  let http: Server
  let ws: WebSocket
  const received: Record<string, unknown>[] = []

  const waitFor = async (pred: () => boolean, ms = 3000): Promise<void> => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (pred()) return
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('waitFor timed out')
  }
  const readRaw = async (id: string): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(path.join(tasksDir, `${id}.json`), 'utf8'))
  const waitForRaw = async (
    id: string,
    pred: (raw: Record<string, unknown>) => boolean,
    ms = 5000,
  ): Promise<Record<string, unknown>> => {
    const start = Date.now()
    let last: Record<string, unknown> | undefined
    while (Date.now() - start < ms) {
      last = await readRaw(id)
      if (pred(last)) return last
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`waitForRaw timed out; last status=${String(last?.status)}`)
  }

  async function seed(id: string, fields: Record<string, unknown>): Promise<void> {
    await writeFile(
      path.join(tasksDir, `${id}.json`),
      JSON.stringify({
        id,
        title: 'Gate task',
        status: 'resting',
        createdAt: AT,
        updatedAt: AT,
        allowEdits: false,
        shape: 2,
        items: [],
        rides: [],
        ...fields,
      }),
    )
  }

  // Announce exactly `flows`, so the gate has something real to disagree with.
  async function connect(flows: string[]): Promise<void> {
    const port = (http.address() as AddressInfo).port
    ws = new WebSocket(`ws://localhost:${port}/daemon?token=${UI_TOKEN}`)
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject)
      ws.on('open', () => resolve())
    })
    ws.on('message', (d) => received.push(JSON.parse(d.toString())))
    ws.send(
      JSON.stringify({
        type: 'register',
        projects: [{ slug }],
        draining: false,
        runs: [],
        flows: flows.map((name) => ({
          scope: 'bundled',
          meta: {
            api: 1,
            name,
            description: name,
            driver: true,
            capabilities: {
              worktrees: false,
              vision: 'read',
              grants: { task: false, project: false },
              usageSnapshot: false,
              rateLimitRetry: false,
              reportsCost: false,
            },
          },
        })),
      }),
    )
    await waitFor(() => daemonServes(slug))
  }

  beforeAll(async () => {
    // Created lazily by task creation elsewhere in this file, so seed() alone
    // can't rely on it (notably when this describe runs under a -t filter).
    await mkdir(tasksDir, { recursive: true })
    http = createServer()
    attachDaemonServer(http, { token: UI_TOKEN })
    await new Promise<void>((r) => http.listen(0, r))
  })

  afterAll(async () => {
    ws?.close()
    await new Promise<void>((r) => http.close(() => r()))
  })

  // Run channels are module state shared by every suite in this file, and an
  // open one with no live owner keeps the reconnect-grace timer armed — see the
  // note on the platform-kill suite's afterEach.
  afterEach(() => {
    for (const m of received)
      if (m.type === 'start-run' && m.runId) closeRunChannel(String(m.runId))
    received.length = 0
  })

  // Other suites in this file share the server process and can be driving their
  // own tasks, so every assertion here is scoped to OUR taskId.
  const startRunFor = (id: string): Record<string, unknown> | undefined =>
    received.find((m) => m.type === 'start-run' && m.taskId === id)

  it('wedges a task whose flow the daemon never announced', async () => {
    await connect(['claude', 'codex'])
    const id = 'gate-unknown'
    await seed(id, { flow: 'open-pr' })

    expect(
      (await post(`/api/${slug}/tasks/${id}/messages`, { message: 'go' })).status,
    ).toBe(200)

    const raw = await waitForRaw(id, (r) => r.status === 'wedged')
    // It wedged with a named cause rather than running as something else.
    expect(JSON.stringify(raw.items)).toContain("no connected daemon provides the flow 'open-pr'")
    // And crucially: nothing was dispatched for this task.
    expect(startRunFor(id)).toBeUndefined()
    ws.close()
    await waitFor(() => !daemonConnected())
  }, 20_000)

  it('dispatches an announced non-legacy flow with `flow` and no `agent`', async () => {
    await connect(['claude', 'codex', 'open-pr'])
    const id = 'gate-announced'
    await seed(id, { flow: 'open-pr', flowConfig: { dryRun: true } })

    expect(
      (await post(`/api/${slug}/tasks/${id}/messages`, { message: 'go' })).status,
    ).toBe(200)

    await waitFor(() => !!startRunFor(id))
    const start = startRunFor(id)!
    expect(start.flow).toBe('open-pr')
    // No `agent`: an old daemon must not be able to read this as a claude run.
    expect(start.agent).toBeUndefined()
    expect(start.flowConfig).toEqual({ dryRun: true })
    ws.close()
    await waitFor(() => !daemonConnected())
  }, 20_000)

  it('still sends `agent` alongside `flow` for a legacy task', async () => {
    // The compatibility half: a daemon that predates `flow` reads `agent` and
    // keeps driving claude and codex.
    await connect(['claude', 'codex'])
    const id = 'gate-legacy'
    await seed(id, { agent: 'codex' })

    expect(
      (await post(`/api/${slug}/tasks/${id}/messages`, { message: 'go' })).status,
    ).toBe(200)

    await waitFor(() => !!startRunFor(id))
    const start = startRunFor(id)!
    expect(start.agent).toBe('codex')
    expect(start.flow).toBe('codex')
    ws.close()
    await waitFor(() => !daemonConnected())
  }, 20_000)

  it('dispatches a legacy flow even when the daemon announced nothing', async () => {
    // The rolled-back-daemon case. Bootstrap entries bypass the gate precisely
    // because start-run carries `agent` for them, so an old daemon can drive
    // them — wedging here would be a regression, not safety.
    await connect([])
    const id = 'gate-legacy-noannounce'
    await seed(id, { agent: 'claude' })

    expect(
      (await post(`/api/${slug}/tasks/${id}/messages`, { message: 'go' })).status,
    ).toBe(200)

    await waitFor(() => !!startRunFor(id))
    expect(startRunFor(id)!.agent).toBe('claude')
    ws.close()
    await waitFor(() => !daemonConnected())
  }, 20_000)
})
