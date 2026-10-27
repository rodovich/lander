import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { normalizeProjectPath, projectSlug } from './projects'
import { observeWrites } from './store'
import { attributedPrompt, type EventItem, type Item, type MessageItem } from './tasks'

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

// A task that has already run a turn: the `lander ride` shape, where nothing is
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

// The prompt the wakeup pushed, as the agent reads it. Read off the items rather
// than `queued`: the sweep fire-and-forgets the drive that drains the queue, so
// `queued` is a race while the item it pushed is not.
async function lastPrompt(id: string): Promise<string> {
  const raw = await readRaw(id)
  const items = (raw.items ?? []) as MessageItem[]
  const last = items.filter((i) => i.role === 'user').at(-1)
  return last ? attributedPrompt(last) : ''
}

// The wakeup is told as lander's notification: a 'notified' event carrying the
// prompt, which is lander's and not the human's.
async function expectNotified(id: string, trigger: string): Promise<void> {
  const items = (await readRaw(id)).items as Item[]
  const prompt = items
    .filter((i): i is MessageItem => i.kind === 'message' && i.role === 'user')
    .at(-1)!
  expect(prompt.from).toEqual({ lander: trigger })
  const event = items.filter((i): i is EventItem => i.kind === 'event').at(-1)!
  expect(event).toMatchObject({ eventKind: 'notified', message: prompt.id })
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
    await expectNotified('awaits-one', 'await')
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

  it('states the date when the condition was a time', async () => {
    await seed('due-timer', { scheduledFor: AT })

    await launchScheduled()

    expect(await lastPrompt('due-timer')).toMatch(/^Current date: .*[^.]$/)
    await expectNotified('due-timer', 'time')
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

    expect(await lastPrompt('fallback-timer')).toMatch(/^Current date: /)
    await expectNotified('fallback-timer', 'time')
    // Both arms are cleared by the launch, the unfired one included.
    expect((await readRaw('fallback-timer')).waitingFor).toBeUndefined()
  })

  it('drives a wedged task’s deferred retry as a plain launch', async () => {
    await seed('due-retry', {
      status: 'wedged',
      scheduledFor: AT,
      queued: ['try again'],
    })

    await launchScheduled()

    const items = (await readRaw('due-retry')).items as Item[]
    const event = items.filter((i): i is EventItem => i.kind === 'event').at(-1)!
    expect(event.eventKind).toBe('launched')
  })

  it('notifies a task that scheduled a ride and then wedged itself', async () => {
    await seed('due-own-ride-wedged', { status: 'wedged', scheduledFor: AT })

    await launchScheduled()

    expect(await lastPrompt('due-own-ride-wedged')).toMatch(/^Current date: /)
    await expectNotified('due-own-ride-wedged', 'time')
  })

  // A human pressing Launch fires no trigger at all: it is the human telling the
  // task to proceed, so it reads as their message and claims no condition.
  it('delivers the human’s Launch as their own “go ahead”', async () => {
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

    expect(await lastPrompt('hand-launched')).toBe('go ahead')
    const items = (await readRaw('hand-launched')).items as Item[]
    expect(items.at(-1)).not.toHaveProperty('from')
    // A plain launch, carrying nothing: the message stands as the human's.
    const event = items.filter((i): i is EventItem => i.kind === 'event').at(-1)!
    expect(event.eventKind).toBe('launched')
    expect(event.message).toBeUndefined()
  })
})

describe('a deferred message to a task with a ride scheduled', () => {
  it('is delivered when due, and the ride stays scheduled', async () => {
    await seed('ride-holder', {
      scheduledFor: LATE,
      waitingFor: ['ride-holder-sibling'],
      scheduledMessages: [
        { text: 'due now', deliverAt: AT, from: { task: 'sender-x', via: 'send' } },
      ],
    })

    await launchScheduled()

    expect(await lastPrompt('ride-holder')).toBe('From sender-x:\n\ndue now')
    const raw = await readRaw('ride-holder')
    expect(raw.scheduledFor).toBe(LATE)
    expect(raw.waitingFor).toEqual(['ride-holder-sibling'])
  })

  // The control: a launch that has not happened yet still holds its messages.
  it('waits for a deferred launch', async () => {
    await seed('launch-holder', {
      scheduledFor: LATE,
      rides: [],
      scheduledMessages: [{ text: 'due now', deliverAt: AT }],
    })

    await launchScheduled()

    expect((await readRaw('launch-holder')).scheduledMessages).toHaveLength(1)
  })
})

// A `--await` delivery is a message, not a scheduled ride firing — it never
// drives the synthetic prompt — and like a message from another task it leaves
// the ride the woken task scheduled.
describe('a notify delivery', () => {
  it('leaves the scheduled ride and the await in place', async () => {
    await seed('notify-launcher', {
      scheduledFor: LATE,
      waitingFor: ['notify-child'],
    })
    await seed('notify-child', {
      pendingNotify: [{ to: 'notify-launcher', at: AT, rideId: 'r0' }],
    })

    const writes = await writesDuring('notify-launcher', launchScheduled)

    const raw = await readRaw('notify-launcher')
    // The message arrived, carrying the child's closing text.
    expect(await lastPrompt('notify-launcher')).toBe(
      'notify-child finished a turn:\n\non it',
    )
    // From the child, not the launcher's human: the record holds the child's
    // words alone, and the header above is composed for the agent.
    expect((raw.items as { text?: string; from?: unknown }[]).at(-1)).toMatchObject({
      text: 'on it',
      from: { task: 'notify-child', via: 'notify' },
    })
    // Nothing cleared, so nothing to tell the woken turn it lost.
    expect(raw.scheduledFor).toBe(LATE)
    expect(writes.some((w) => w.revived)).toBe(false)
    expect(raw.waitingFor).toEqual(['notify-child'])
    // One-shot: consumed on delivery so the next sweep doesn't wake it again.
    expect((await readRaw('notify-child')).pendingNotify).toBeUndefined()
  })

  it('leaves a launcher with no scheduled ride nothing to report', async () => {
    await seed('notify-plain-launcher', {})
    await seed('notify-plain-child', {
      pendingNotify: [{ to: 'notify-plain-launcher', at: AT, rideId: 'r0' }],
    })

    await launchScheduled()

    await vi.waitFor(async () => {
      expect(await lastPrompt('notify-plain-launcher')).toContain(
        'finished a turn',
      )
    })
    expect((await readRaw('notify-plain-launcher')).revived).toBeUndefined()
  })

  // The shape from before several could wait, still on disk if it fired before
  // an upgrade and was not yet delivered.
  it('delivers a notification stored as a single object', async () => {
    await seed('notify-legacy-launcher', {})
    await seed('notify-legacy-child', {
      pendingNotify: { to: 'notify-legacy-launcher', at: AT, rideId: 'r0' },
    })

    await launchScheduled()

    expect(await lastPrompt('notify-legacy-launcher')).toBe(
      'notify-legacy-child finished a turn:\n\non it',
    )
    expect((await readRaw('notify-legacy-child')).pendingNotify).toBeUndefined()
  })

  // Each waiter hears the turn that fired its notification, which in one drain
  // need not be the same turn.
  it('wakes every waiter with the closing message of its own turn', async () => {
    await seed('notify-many-launcher', {})
    await seed('notify-many-sender', {})
    await seed('notify-many-child', {
      items: [
        { id: 'u0', at: AT, kind: 'message', role: 'user', text: 'go' },
        { id: 'f0', at: AT, rideId: 'r0', kind: 'message', role: 'flow', text: 'first' },
        { id: 'u1', at: AT, kind: 'message', role: 'user', text: 'and?' },
        { id: 'f1', at: AT, rideId: 'r1', kind: 'message', role: 'flow', text: 'second' },
      ],
      rides: [
        { id: 'r0', startedAt: AT, endedAt: AT, outcome: 'done' },
        { id: 'r1', startedAt: AT, endedAt: AT, outcome: 'done' },
      ],
      pendingNotify: [
        { to: 'notify-many-launcher', at: AT, rideId: 'r0' },
        { to: 'notify-many-sender', at: AT, rideId: 'r1' },
      ],
    })

    await launchScheduled()

    expect(await lastPrompt('notify-many-launcher')).toBe(
      'notify-many-child finished a turn:\n\nfirst',
    )
    expect(await lastPrompt('notify-many-sender')).toBe(
      'notify-many-child finished a turn:\n\nsecond',
    )
    expect((await readRaw('notify-many-child')).pendingNotify).toBeUndefined()
  })
})
