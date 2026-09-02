import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { normalizeProjectPath } from './projects'

// A naming call takes seconds, and the flag that tells the retry sites "this
// task still needs a name" is set for all of them. The stub keeps the call open
// long enough for a second trigger to arrive while the first is in flight — the
// live shape, where the opening turn starts milliseconds after creation — and
// counts what actually got asked of the model.
const calls: string[] = []
let answer: string | null = null
vi.mock('./title', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./title')>()),
  generateTitle: vi.fn(async (_dir: string, source: string) => {
    calls.push(source)
    await new Promise((r) => setTimeout(r, 80))
    return answer
  }),
}))

const AT = '2026-01-01T00:00:00.000Z'

let recoverQueues: (typeof import('./index'))['recoverQueues']
let projectDir: string
let dataDirRoot: string
let tasksDir: string
let originalEnv: NodeJS.ProcessEnv

async function readRaw(id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(tasksDir, `${id}.json`), 'utf8'))
}

beforeAll(async () => {
  originalEnv = { ...process.env }
  projectDir = await mkdtemp(path.join(tmpdir(), 'lander-naming-project-'))
  dataDirRoot = await mkdtemp(path.join(tmpdir(), 'lander-naming-data-'))
  tasksDir = path.join(dataDirRoot, normalizeProjectPath(projectDir), 'tasks')

  process.env.NODE_ENV = 'test'
  process.env.LANDER_DATA_ROOT = dataDirRoot
  process.env.PROJECT_DIRS = projectDir
  process.env.LANDER_UI_TOKEN = 'test-ui-token'

  await mkdir(tasksDir, { recursive: true })
  ;({ recoverQueues } = await import('./index'))
})

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true })
  await rm(dataDirRoot, { recursive: true, force: true })
  process.env = originalEnv
})

describe('a task is named once at a time', () => {
  it('lets one naming call finish before another trigger can start a second', async () => {
    // An unnamed task with its opening message still queued reaches both retry
    // sites in one sweep: the boot retry fires on the flag, then the queue drain
    // wakes driveTask, which sees the same flag — the same pair of triggers a
    // fresh launch produces, creation and then the opening turn.
    await writeFile(
      path.join(tasksDir, 'named-once.json'),
      JSON.stringify({
        id: 'named-once',
        title: '…',
        titlePending: true,
        status: 'riding',
        createdAt: AT,
        updatedAt: AT,
        allowEdits: false,
        shape: 2,
        items: [
          { id: 'named-once-0', at: AT, kind: 'message', role: 'user', text: 'opening' },
        ],
        queued: ['opening'],
      }),
    )

    // The first attempt fails, so the flag survives it: the shape a transient
    // failure leaves behind, and the one where a second trigger inside the
    // window would otherwise have fired a second call.
    answer = null
    await recoverQueues()
    await vi.waitFor(async () => {
      expect((await readRaw('named-once')).queued ?? []).not.toEqual(['opening'])
    })
    await new Promise((r) => setTimeout(r, 200))
    expect(calls).toEqual(['opening'])
    expect((await readRaw('named-once')).titlePending).toBe(true)

    // The guard is per call, not per task: once the first call has ended, the
    // next trigger names it. Otherwise a failed first attempt could never be
    // retried, which is the whole point of the flag.
    answer = 'Named on retry'
    await recoverQueues()
    await vi.waitFor(async () => {
      expect((await readRaw('named-once')).title).toBe('Named on retry')
    })
    expect(calls).toEqual(['opening', 'opening'])
    expect((await readRaw('named-once')).titlePending).toBeUndefined()
  })
})
