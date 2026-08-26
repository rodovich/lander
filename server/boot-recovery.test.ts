import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { normalizeProjectPath } from './projects'

// The naming child is a real `claude` process; stubbing it is what makes the
// retry observable as a name landing on the record rather than as a spawn.
vi.mock('./title', () => ({
  generateTitle: vi.fn(async () => 'Named by the stub'),
}))

// The boot sweep drives anything carrying a queued message, and a deferred task
// carries its opening message in that queue for the whole wait. So without a
// trigger check the sweep launches every deferred task in every project on every
// restart — bypassing launchTask, which is what clears the trigger and records the
// `launched` event. The await arm was missing from that check from the day
// `--await` shipped (63ed0f5), and this repo restarts its server on every
// `server/**` edit. Observed three times in the live data, most recently on
// 2026-08-26: a task awaiting a stalled sibling rode 2.1s after a server boot.
// The compounding half is why the skip has to be a skip and not a clear: because
// this path leaves `waitingFor` set, the scheduler fires launchTask later anyway
// and pushes a spurious "Resumed at …" into a task that already ran.

const AT = '2026-01-01T00:00:00.000Z'

let recoverQueues: (typeof import('./index'))['recoverQueues']
let projectDir: string
let dataDirRoot: string
let tasksDir: string
let originalEnv: NodeJS.ProcessEnv

// Seeded straight onto disk: this is the state a previous process left behind,
// which is the only way the boot sweep ever sees a task.
function seed(id: string, extra: Record<string, unknown>): Promise<void> {
  return writeFile(
    path.join(tasksDir, `${id}.json`),
    JSON.stringify({
      id,
      title: id,
      // A resting task stores as `riding` under the status collapse, so this is
      // what a deferred task looks like at rest.
      status: 'riding',
      createdAt: AT,
      updatedAt: AT,
      allowEdits: false,
      shape: 2,
      items: [
        { id: `${id}-0`, at: AT, kind: 'message', role: 'user', text: 'opening' },
      ],
      queued: ['opening'],
      ...extra,
    }),
  )
}

async function readRaw(id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(tasksDir, `${id}.json`), 'utf8'))
}

beforeAll(async () => {
  originalEnv = { ...process.env }
  projectDir = await mkdtemp(path.join(tmpdir(), 'lander-boot-project-'))
  dataDirRoot = await mkdtemp(path.join(tmpdir(), 'lander-boot-data-'))
  tasksDir = path.join(dataDirRoot, normalizeProjectPath(projectDir), 'tasks')

  process.env.NODE_ENV = 'test'
  process.env.LANDER_DATA_ROOT = dataDirRoot
  process.env.PROJECT_DIRS = projectDir
  process.env.LANDER_UI_TOKEN = 'test-ui-token'

  await mkdir(tasksDir, { recursive: true })
  // Importing the module does not run the sweep (main() is gated on NODE_ENV),
  // so the test calls it explicitly — as a boot would.
  ;({ recoverQueues } = await import('./index'))
})

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true })
  await rm(dataDirRoot, { recursive: true, force: true })
  process.env = originalEnv
})

describe('boot recovery leaves a deferred task to the scheduler', () => {
  it('skips a task awaiting a sibling, and one awaiting a time', async () => {
    await seed('boot-awaiting', { waitingFor: ['sibling-y'] })
    await seed('boot-scheduled', { scheduledFor: '2099-01-01T00:00:00.000Z' })
    await seed('boot-plain', {})

    await recoverQueues()

    for (const id of ['boot-awaiting', 'boot-scheduled']) {
      const raw = await readRaw(id)
      // Untouched: the opening message is still queued for the launch that will
      // drain it, no ride was opened, and the record was never rewritten.
      expect(raw.queued, `${id} queue`).toEqual(['opening'])
      expect(raw.rides ?? [], `${id} rides`).toEqual([])
      expect(raw.updatedAt, `${id} updatedAt`).toBe(AT)
    }
    // The trigger survives for launchScheduled to fire on — skipping must not
    // double as disarming.
    expect(await readRaw('boot-awaiting').then((r) => r.waitingFor)).toEqual([
      'sibling-y',
    ])

    // The control, which proves the sweep ran at all: nothing defers this one, so
    // recovery drives it and driveTask takes the queue before running the turn.
    const plain = await readRaw('boot-plain')
    expect(plain.queued ?? []).not.toEqual(['opening'])
  })
})

// A restart is what strands a name in the first place — the naming child belongs
// to the process it killed — so the boot that follows is the natural place to
// try again.
describe('boot recovery retries a name a restart cut short', () => {
  it('names a flagged task, including one still waiting for its trigger', async () => {
    // Wedged with an empty queue: the shape of a task whose user stopped
    // replying. The sweep passes over it and driveTask — where the only other
    // retry lives — is never called for it. This is the live record that has sat
    // called "…" since 2026-06-30.
    await seed('boot-unnamed', {
      title: '…',
      titlePending: true,
      status: 'wedged',
      queued: [],
    })
    await seed('boot-unnamed-deferred', {
      title: '…',
      titlePending: true,
      scheduledFor: '2099-01-01T00:00:00.000Z',
    })
    await seed('boot-keeps-its-name', {})

    await recoverQueues()

    // Fire-and-forget, so the sweep returns before the names land.
    await vi.waitFor(async () => {
      expect((await readRaw('boot-unnamed')).title).toBe('Named by the stub')
      // The deferred one matters most: the sweep skips it for every other
      // purpose, and it has had no turn for the wakeup retry to ride in on.
      expect((await readRaw('boot-unnamed-deferred')).title).toBe(
        'Named by the stub',
      )
    })
    // Flag cleared, or the next boot names it all over again.
    expect((await readRaw('boot-unnamed')).titlePending).toBeUndefined()
    // The negative control: an unflagged task is left alone, so the retry cannot
    // pass by renaming everything it sweeps.
    expect((await readRaw('boot-keeps-its-name')).title).toBe('boot-keeps-its-name')
  })
})
