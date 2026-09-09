import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { normalizeProjectPath, projectSlug } from './projects'
import { observeWrites } from './store'

// What a resumed session is told about why it is awake. Driven through one real
// sweep over a seeded data dir, because launchTask decides the wording from
// state the sweep resolves for it — neither half is observable alone.

const AT = '2026-01-01T00:00:00.000Z'
const LATE = '2099-01-01T00:00:00.000Z'

let launchScheduled: (typeof import('./index'))['launchScheduled']
let projectDir: string
let dataDirRoot: string
let tasksDir: string
let originalEnv: NodeJS.ProcessEnv

// A task that has already run a turn: the `lander rest` shape, where nothing is
// queued and the wakeup drives the synthetic prompt rather than an opening
// message. Seeded straight onto disk, which is how the sweep always sees one.
function seed(id: string, extra: Record<string, unknown>): Promise<void> {
  return writeFile(
    path.join(tasksDir, `${id}.json`),
    JSON.stringify({
      id,
      title: id,
      status: 'riding',
      createdAt: AT,
      updatedAt: AT,
      allowEdits: false,
      shape: 2,
      items: [
        { id: `${id}-0`, at: AT, kind: 'message', role: 'user', text: 'go' },
        {
          id: `${id}-1`,
          at: AT,
          rideId: 'r0',
          kind: 'message',
          role: 'flow',
          text: 'on it',
        },
      ],
      rides: [{ id: 'r0', startedAt: AT, endedAt: AT, outcome: 'done' }],
      ...extra,
    }),
  )
}

async function readRaw(id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(tasksDir, `${id}.json`), 'utf8'))
}

// Every version of a task's record committed while `run` ran, for a field whose
// whole life is the moment in between: the delivery that stamps `revived` starts
// the drain that consumes and deletes it, so reading the file afterwards races
// that drain and loses often enough to flake.
async function writesDuring(
  id: string,
  run: () => Promise<unknown>,
): Promise<Record<string, unknown>[]> {
  const file = path.join(tasksDir, `${id}.json`)
  const writes: Record<string, unknown>[] = []
  const stop = observeWrites((written, value) => {
    if (written === file) writes.push(value as Record<string, unknown>)
  })
  try {
    await run()
    return writes
  } finally {
    stop()
  }
}

// The prompt the wakeup pushed. Read off the items rather than `queued`: the
// sweep fire-and-forgets the drive that drains the queue, so `queued` is a race
// while the item it pushed is not.
async function lastPrompt(id: string): Promise<string> {
  const raw = await readRaw(id)
  const items = (raw.items ?? []) as { role?: string; text?: string }[]
  return items.filter((i) => i.role === 'user').at(-1)?.text ?? ''
}

beforeAll(async () => {
  originalEnv = { ...process.env }
  projectDir = await mkdtemp(path.join(tmpdir(), 'lander-wakeup-project-'))
  dataDirRoot = await mkdtemp(path.join(tmpdir(), 'lander-wakeup-data-'))
  tasksDir = path.join(dataDirRoot, normalizeProjectPath(projectDir), 'tasks')

  process.env.NODE_ENV = 'test'
  process.env.LANDER_DATA_ROOT = dataDirRoot
  process.env.PROJECT_DIRS = projectDir
  process.env.LANDER_UI_TOKEN = 'test-ui-token'

  await mkdir(tasksDir, { recursive: true })
  // Importing the module does not start the scheduler (main() is gated on
  // NODE_ENV), so the test drives one pass itself.
  ;({ launchScheduled } = await import('./index'))
})

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true })
  await rm(dataDirRoot, { recursive: true, force: true })
  process.env = originalEnv
})

describe('the prompt a fired wakeup drives', () => {
  it('names the awaited tasks that landed, and no time', async () => {
    await seed('await-one-landed', { status: 'landed' })
    await seed('awaits-one', { waitingFor: ['await-one-landed'] })

    await launchScheduled()

    expect(await lastPrompt('awaits-one')).toBe('Task landed: await-one-landed')
    expect((await readRaw('awaits-one')).waitingFor).toBeUndefined()
  })

  it('pluralizes the noun alone, listing every awaited id', async () => {
    await seed('await-two-a', { status: 'landed' })
    await seed('await-two-b', { status: 'landed' })
    await seed('awaits-two', { waitingFor: ['await-two-a', 'await-two-b'] })

    await launchScheduled()

    expect(await lastPrompt('awaits-two')).toBe(
      'Tasks landed: await-two-a, await-two-b',
    )
  })

  it('reads as the moment when the condition was a time', async () => {
    await seed('due-timer', { scheduledFor: AT })

    await launchScheduled()

    expect(await lastPrompt('due-timer')).toMatch(/^Resumed at .*[^.]$/)
  })

  // The OR fallback with only the timer due: the await condition was never met,
  // so nothing may say it was.
  it('does not claim a landing when the fallback timer is what fired', async () => {
    await seed('fallback-sibling', { status: 'riding' })
    await seed('fallback-timer', {
      scheduledFor: AT,
      waitingFor: ['fallback-sibling'],
    })

    await launchScheduled()

    expect(await lastPrompt('fallback-timer')).toMatch(/^Resumed at /)
    // Both arms are cleared by the launch, the unfired one included.
    expect((await readRaw('fallback-timer')).waitingFor).toBeUndefined()
  })

  // A human pressing Launch fires no trigger at all, so the timestamp is the
  // only claim left that is true: `at` is the actual moment, not the schedule
  // the human jumped.
  it('falls back to the moment for a launch that fired no trigger', async () => {
    await seed('hand-launched', {
      scheduledFor: LATE,
      waitingFor: ['fallback-sibling'],
    })
    const { app } = await import('./index')
    const res = await app.request(
      `/api/${projectSlug(projectDir)}/tasks/hand-launched/launch`,
      { method: 'POST', headers: { 'x-lander-ui-token': 'test-ui-token' } },
    )
    expect(res.status).toBe(200)

    expect(await lastPrompt('hand-launched')).toMatch(/^Resumed at /)
  })
})
