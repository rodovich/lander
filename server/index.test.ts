import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
          messages: [
            { role: 'user', text: 'make a file', createdAt: AT },
            { role: 'assistant', text: '', createdAt: AT, pending: true },
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
    // The ref lands on the pending assistant message.
    expect(raw.messages[1].artifacts).toHaveLength(1)
    expect(raw.messages[1].artifacts[0].name).toBe('out.txt')

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
    // The generating message keeps a single ref for the name (updated in place),
    // not a second stale chip from the republish.
    expect(raw.messages[1].artifacts).toHaveLength(1)
    expect(raw.messages[1].artifacts[0].id).toBe(raw.artifacts[0].id)

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

  // Seed a wedged task on disk with a token, so a create/answer has an owner and
  // (for answer tests) an ask already open.
  async function seedTask(id: string, over: Raw = {}): Promise<void> {
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
          messages: [{ role: 'user', text: 'go', createdAt: AT }],
          ...over,
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
    expect((raw.asks as Raw[]).map((a) => a.id)).toEqual([ask.id])
    // The wedge crossing is recorded so it surfaces in the timeline.
    expect((raw.events as Raw[]).some((e) => e.kind === 'wedged')).toBe(true)
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

  it('400s an empty prompt, a malformed form, or an unimplemented blocking level', async () => {
    const id = 'ask-create-valid'
    await seedTask(id)
    expect((await create(id, { prompt: '  ', form: choiceForm })).status).toBe(400)
    expect(
      (await create(id, { prompt: 'p', form: { type: 'choice', options: [] } }))
        .status,
    ).toBe(400)
    const ride = await create(id, {
      prompt: 'p',
      form: choiceForm,
      blocking: 'ride',
    })
    expect(ride.status).toBe(400)
    expect(((await ride.json()) as { error: string }).error).toMatch(/not implemented/)
  })

  it('answers immediately: un-wedges, queues the delivery, marks the ask answered', async () => {
    const id = 'ask-answer'
    await seedTask(id, { status: 'wedged', asks: [openAsk()] })
    const res = await answer(id, 'ask-seed-0', { optionId: 'b' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      status: string
      asks: Raw[]
      messages: { role: string; text: string; queued?: boolean }[]
    }
    expect(body.status).toBe('riding')
    expect(body.asks[0].state).toBe('answered')
    // The delivery is appended as a queued user message carrying the chosen label.
    const last = body.messages[body.messages.length - 1]
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
    expect((raw.events as Raw[]).some((e) => e.kind === 'scheduled')).toBe(true)
    expect(raw.queued).toEqual(['Answer to "Pick one": Later'])
    expect((raw.asks as Raw[])[0].state).toBe('answered')
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
    expect((raw.asks as Raw[])[0].state).toBe('withdrawn')
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
    expect((raw.asks as Raw[])[0].state).toBe('withdrawn')
  })

  it('withdraws an open ask when the task is relaunched', async () => {
    const id = 'ask-withdraw-relaunch'
    await seedTask(id, { status: 'wedged', asks: [openAsk()] })
    const res = await post(`/api/${slug}/tasks/${id}/relaunch`, {
      message: 'start over',
    })
    expect(res.status).toBe(200)
    const raw = await readRaw(id)
    expect((raw.asks as Raw[])[0].state).toBe('withdrawn')
  })
})
