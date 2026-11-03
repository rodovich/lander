import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckRunResponse } from './daemon'
import { normalizeProjectPath, projectSlug } from './projects'
import { attributedPrompt, type EventItem, type Item, type MessageItem } from './tasks'

// Watches end to end on the server: the ride endpoint arms one, the sweep runs
// it, and its result wakes, waits, or wedges the task. The daemon's answer is the
// one thing faked.

const { requestCheckRun } = vi.hoisted(() => ({
  requestCheckRun: vi.fn<(input: unknown) => Promise<CheckRunResponse>>(),
}))
vi.mock('./daemon', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./daemon')>()),
  requestCheckRun,
}))

const UI_TOKEN = 'test-ui-token'
const AT = '2026-01-01T00:00:00.000Z'
const LONG_AGO = '2000-01-01T00:00:00.000Z'

let app: (typeof import('./index'))['app']
let launchScheduled: (typeof import('./index'))['launchScheduled']
let projectDir: string
let dataDirRoot: string
let tasksDir: string
let slug: string
let originalEnv: NodeJS.ProcessEnv

function seed(id: string, extra: Record<string, unknown> = {}): Promise<void> {
  return writeFile(
    path.join(tasksDir, `${id}.json`),
    JSON.stringify({
      id,
      title: id,
      status: 'riding',
      createdAt: AT,
      updatedAt: AT,
      shape: 2,
      items: [
        { id: `${id}-0`, at: AT, kind: 'message', role: 'user', text: 'go' },
        { id: `${id}-1`, at: AT, rideId: 'r0', kind: 'message', role: 'flow', text: 'ok' },
      ],
      rides: [{ id: 'r0', startedAt: AT, endedAt: AT, outcome: 'done' }],
      ...extra,
    }),
  )
}

async function readRaw(id: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(path.join(tasksDir, `${id}.json`), 'utf8'))
}

async function post(pathname: string, body: unknown): Promise<Response> {
  return app.request(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lander-ui-token': UI_TOKEN },
    body: JSON.stringify(body),
  })
}

function armWatch(id: string, args: Record<string, string> = { thing: 'a' }) {
  return post(`/api/${slug}/tasks/${id}/ride`, { watch: { check: 'probe', args } })
}

function watching(lastRunAt: string, extra: Record<string, unknown> = {}) {
  return {
    watch: { check: 'probe', args: { thing: 'a' }, armedAt: AT, lastRunAt, ...extra },
  }
}

const answer = (outcome: CheckRunResponse['outcome']): CheckRunResponse => ({
  ok: true,
  outcome,
})

beforeAll(async () => {
  originalEnv = { ...process.env }
  projectDir = await mkdtemp(path.join(tmpdir(), 'lander-watch-project-'))
  dataDirRoot = await mkdtemp(path.join(tmpdir(), 'lander-watch-data-'))
  tasksDir = path.join(dataDirRoot, normalizeProjectPath(projectDir), 'tasks')
  slug = projectSlug(projectDir)
  process.env.NODE_ENV = 'test'
  process.env.LANDER_DATA_ROOT = dataDirRoot
  process.env.PROJECT_DIRS = projectDir
  process.env.LANDER_UI_TOKEN = UI_TOKEN
  await mkdir(tasksDir, { recursive: true })
  await writeFile(
    path.join(dataDirRoot, 'checks.json'),
    JSON.stringify({ enabled: ['probe'] }),
  )
  ;({ app, launchScheduled } = await import('./index'))
  const { setAnnouncedChecks } = await import('./checks')
  setAnnouncedChecks([
    { name: 'probe', description: 'test', args: { thing: { description: 'x' } } },
    { name: 'off', description: 'never switched on', args: {} },
  ])
})

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true })
  await rm(dataDirRoot, { recursive: true, force: true })
  process.env = originalEnv
})

beforeEach(() => {
  requestCheckRun.mockReset()
})

describe('arming a watch', () => {
  it('refuses an unknown check and a switched-off one without running either', async () => {
    await seed('arm-refused')
    const unknown = await post(`/api/${slug}/tasks/arm-refused/ride`, {
      watch: { check: 'nope', args: {} },
    })
    expect(unknown.status).toBe(400)
    const off = await post(`/api/${slug}/tasks/arm-refused/ride`, {
      watch: { check: 'off', args: {} },
    })
    expect(off.status).toBe(400)
    expect((await off.json()).error).toMatch(/Hooks panel/)
    expect(requestCheckRun).not.toHaveBeenCalled()
  })

  it('rejects --watch with another trigger', async () => {
    await seed('arm-combined')
    const res = await post(`/api/${slug}/tasks/arm-combined/ride`, {
      watch: { check: 'probe', args: {} },
      time: 5,
    })
    expect(res.status).toBe(400)
  })

  it('arms after a quiet first run, saving its state and adding no item', async () => {
    await seed('arm-quiet')
    requestCheckRun.mockResolvedValueOnce(answer({ kind: 'quiet', state: { n: 1 } }))
    const res = await armWatch('arm-quiet')
    expect(res.status).toBe(200)
    const served = await res.json()
    expect(served.watch).toMatchObject({ check: 'probe', args: { thing: 'a' } })
    expect(served.watchState).toBeUndefined()
    const raw = await readRaw('arm-quiet')
    expect(raw.watch.lastRunAt).toBe(raw.watch.armedAt)
    expect(Object.values(raw.watchState)).toEqual([{ n: 1 }])
    expect(raw.items).toHaveLength(2)
  })

  it('does not arm when the first run fires, and says so', async () => {
    await seed('arm-fired')
    requestCheckRun.mockResolvedValueOnce(
      answer({ kind: 'fired', state: { n: 2 }, message: 'it happened' }),
    )
    const served = await (await armWatch('arm-fired')).json()
    expect(served).toMatchObject({ fired: true, message: 'it happened' })
    const raw = await readRaw('arm-fired')
    expect(raw.watch).toBeUndefined()
    expect(Object.values(raw.watchState)).toEqual([{ n: 2 }])
  })

  it('arms nothing when the check errors or no daemon answers', async () => {
    await seed('arm-error')
    requestCheckRun.mockResolvedValueOnce(
      answer({ kind: 'error', error: 'bad path', permanent: true }),
    )
    const bad = await armWatch('arm-error')
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe('bad path')
    requestCheckRun.mockResolvedValueOnce({ ok: false, error: 'none', status: 503 })
    expect((await armWatch('arm-error')).status).toBe(503)
    expect((await readRaw('arm-error')).watch).toBeUndefined()
  })

  it('resumes from the state saved by the last watch on the same check and args', async () => {
    await seed('arm-resume')
    requestCheckRun.mockResolvedValueOnce(
      answer({ kind: 'fired', state: { cursor: 7 }, message: 'm' }),
    )
    await armWatch('arm-resume')
    requestCheckRun.mockResolvedValueOnce(answer({ kind: 'quiet', state: {} }))
    await armWatch('arm-resume')
    expect(requestCheckRun.mock.calls[1][0]).toMatchObject({ prevState: { cursor: 7 } })
    requestCheckRun.mockResolvedValueOnce(answer({ kind: 'quiet', state: {} }))
    await armWatch('arm-resume', { thing: 'b' })
    expect((requestCheckRun.mock.calls[2][0] as { prevState?: unknown }).prevState).toBeUndefined()
  })

  it('maps a check that may succeed later to 503, and does not revive a task that landed meanwhile', async () => {
    await seed('arm-transient')
    requestCheckRun.mockResolvedValueOnce(
      answer({ kind: 'error', error: 'timed out', permanent: false }),
    )
    expect((await armWatch('arm-transient')).status).toBe(503)

    await seed('arm-landing')
    requestCheckRun.mockImplementationOnce(async () => {
      const raw = await readRaw('arm-landing')
      await writeFile(
        path.join(tasksDir, 'arm-landing.json'),
        JSON.stringify({ ...raw, status: 'landed' }),
      )
      return answer({ kind: 'quiet', state: {} })
    })
    expect((await armWatch('arm-landing')).status).toBe(409)
    const raw = await readRaw('arm-landing')
    expect(raw.status).toBe('landed')
    expect(raw.watch).toBeUndefined()
  })

  it('is replaced by a timed ride and dropped by --clear', async () => {
    await seed('arm-replaced', watching(AT))
    await post(`/api/${slug}/tasks/arm-replaced/ride`, { time: 60 })
    const raw = await readRaw('arm-replaced')
    expect(raw.watch).toBeUndefined()
    expect(raw.scheduledFor).toBeDefined()

    await seed('arm-cleared', watching(AT))
    const cleared = await post(`/api/${slug}/tasks/arm-cleared/ride`, { clear: true })
    expect((await cleared.json()).cleared).toBe(true)
    expect((await readRaw('arm-cleared')).watch).toBeUndefined()
  })
})

describe('a watch across the task’s life', () => {
  it('survives a message from the human, which is reminded of it', async () => {
    // Not yet due, so no sweep in this file runs it.
    await seed('life-message', watching(new Date().toISOString()))
    const res = await post(`/api/${slug}/tasks/life-message/messages`, { message: 'hi' })
    expect(res.status).toBeLessThan(300)
    const raw = await readRaw('life-message')
    expect(raw.watch).toMatchObject({ check: 'probe' })
    expect(raw.revived?.waitingUntil).toBeUndefined()
    const { scheduledRideOf } = await import('./tasks')
    expect(scheduledRideOf(raw)).toEqual({
      watching: { check: 'probe', args: { thing: 'a' } },
    })
  })

  it('is deleted with its saved state when the task lands', async () => {
    const { recordStatusTransition } = await import('./tasks')
    const task: Record<string, any> = {
      status: 'riding',
      title: 't',
      ...watching(AT),
      watchState: { k: 1 },
    }
    recordStatusTransition(task as never, 'landed', AT, 'human')
    expect(task.watch).toBeUndefined()
    expect(task.watchState).toBeUndefined()
  })
})

describe('the sweep running a watch', () => {
  it('records a quiet run without moving the task in the list or adding items', async () => {
    await seed('sweep-quiet', watching(LONG_AGO))
    requestCheckRun.mockResolvedValue(answer({ kind: 'quiet', state: { n: 3 } }))
    await launchScheduled()
    await vi.waitFor(async () =>
      expect((await readRaw('sweep-quiet')).watch.lastRunAt).not.toBe(LONG_AGO),
    )
    const raw = await readRaw('sweep-quiet')
    expect(raw.updatedAt).toBe(AT)
    expect(raw.items).toHaveLength(2)
    expect(Object.values(raw.watchState)).toEqual([{ n: 3 }])
  })

  it('does not run a watch that is not yet due, or one on a wedged task', async () => {
    await seed('sweep-not-due', watching(new Date().toISOString()))
    await seed('sweep-wedged', { ...watching(LONG_AGO), status: 'wedged' })
    requestCheckRun.mockResolvedValue(answer({ kind: 'quiet', state: {} }))
    await launchScheduled()
    const ran = requestCheckRun.mock.calls.map((c) => (c[0] as { taskId: string }).taskId)
    expect(ran).not.toContain('sweep-not-due')
    expect(ran).not.toContain('sweep-wedged')
  })

  it('wakes the task with the check’s message when it fires', async () => {
    await seed('sweep-fired', watching(LONG_AGO))
    requestCheckRun.mockResolvedValue(
      answer({ kind: 'fired', state: { n: 4 }, message: 'the file changed' }),
    )
    await launchScheduled()
    await vi.waitFor(async () => {
      const items = (await readRaw('sweep-fired')).items as Item[]
      expect(items.some((i) => i.kind === 'event' && i.eventKind === 'notified')).toBe(true)
    })
    const raw = await readRaw('sweep-fired')
    const prompt = (raw.items as Item[])
      .filter((i): i is MessageItem => i.kind === 'message' && i.role === 'user')
      .at(-1)!
    expect(prompt.from).toEqual({ lander: 'watch' })
    expect(attributedPrompt(prompt)).toContain('the file changed')
    expect(raw.watch).toBeUndefined()
    expect(Object.values(raw.watchState)).toEqual([{ n: 4 }])
  })

  it('keeps retrying a failing check until it has failed twelve runs in a row, then wedges', async () => {
    await seed('sweep-failing', watching(LONG_AGO))
    requestCheckRun.mockResolvedValue(
      answer({ kind: 'error', error: 'flaky', permanent: false }),
    )
    await launchScheduled()
    await vi.waitFor(async () =>
      expect((await readRaw('sweep-failing')).watch.failures).toBe(1),
    )
    expect((await readRaw('sweep-failing')).status).toBe('riding')

    await seed('sweep-failed', watching(LONG_AGO, { failures: 11 }))
    await launchScheduled()
    await vi.waitFor(async () => expect((await readRaw('sweep-failed')).status).toBe('wedged'))
    const raw = await readRaw('sweep-failed')
    expect(raw.watch).toBeUndefined()
    const wedged = (raw.items as Item[])
      .filter((i): i is EventItem => i.kind === 'event')
      .at(-1)!
    expect(wedged).toMatchObject({ eventKind: 'wedged', reason: 'watch probe failed: flaky' })
  })

  it('wedges at once on a permanent error', async () => {
    await seed('sweep-permanent', watching(LONG_AGO))
    requestCheckRun.mockResolvedValue(
      answer({ kind: 'error', error: 'gone', permanent: true }),
    )
    await launchScheduled()
    await vi.waitFor(async () =>
      expect((await readRaw('sweep-permanent')).status).toBe('wedged'),
    )
  })

  it('stops a watch whose check the user switched off after it was armed', async () => {
    const checksFile = path.join(dataDirRoot, 'checks.json')
    await seed('sweep-switched-off', watching(LONG_AGO))
    await writeFile(checksFile, JSON.stringify({ enabled: [] }))
    try {
      await launchScheduled()
      await vi.waitFor(async () =>
        expect((await readRaw('sweep-switched-off')).status).toBe('wedged'),
      )
      const ran = requestCheckRun.mock.calls.map((c) => (c[0] as { taskId: string }).taskId)
      expect(ran).not.toContain('sweep-switched-off')
    } finally {
      await writeFile(checksFile, JSON.stringify({ enabled: ['probe'] }))
    }
  })

  it('does not count a missing daemon toward the failure streak', async () => {
    await seed('sweep-no-daemon', watching(LONG_AGO))
    requestCheckRun.mockResolvedValue({ ok: false, error: 'none', status: 503 })
    await launchScheduled()
    await vi.waitFor(() => expect(requestCheckRun).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 50))
    const raw = await readRaw('sweep-no-daemon')
    expect(raw.watch).toEqual(watching(LONG_AGO).watch)
  })
})
