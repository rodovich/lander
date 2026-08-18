import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchPendingHooks, MAX_HOOK_DISPATCH_ATTEMPTS } from './hook-dispatch'
import { clearHookRunState } from './hook-runs'
import type { Project } from './projects'
import type { HookRunReport } from './protocol'
import type { HookItem, Item, PendingHook } from './tasks'

// The dispatcher, driven against real task files with the daemon round trip and
// the git resolution both injected. What is being tested is the bookkeeping —
// which failures retry, which give up, what lands on the timeline, and what is
// left pending — because that is where a mistake is silent.

let root: string
let project: Project
const AT = '2026-01-01T00:00:00.000Z'

const fire = (over: Partial<PendingHook> = {}): PendingHook => ({
  id: 'fire-1-abc',
  trigger: 'ride-ended',
  by: 'agent',
  at: AT,
  rideId: 'ride-1',
  outcome: 'done',
  ...over,
})

const SUPERVISE = '.lander/hooks/ride-ended/any/supervise.js'
const BLOB = 'b10bb10bb10bb10bb10bb10bb10bb10bb10bb10b'

const outcome = (over: Record<string, unknown> = {}) => ({
  path: SUPERVISE,
  blob: BLOB,
  trigger: 'ride-ended',
  by: 'any',
  name: 'supervise',
  state: 'approved' as const,
  runs: BLOB,
  ...over,
})

// A resolve seam that answers with whatever hooks the test declares.
type ResolveInput = { select?: { trigger?: string; by?: string }[] }

const resolving = (hooks: unknown[], ok = true) =>
  vi.fn(async (_input: ResolveInput) =>
    ok
      ? {
          ok: true as const,
          hooks: {
            cwd: '/x',
            trustRoot: { ref: null, configured: false },
            hooks: hooks as never,
          },
        }
      : { ok: false as const, error: 'no daemon', status: 503 },
  )

// A daemon seam that answers with one report.
type SentRun = { hook: { path: string; runs: string }; fireId: string }

const running = (report: HookRunReport | null, ok = true) =>
  vi.fn(async (_msg: SentRun) =>
    ok ? { ok: true, report: report ?? undefined } : { ok: false, status: 503 },
  )

async function writeTask(id: string, over: Record<string, unknown> = {}) {
  await writeFile(
    path.join(project.dataDir, `${id}.json`),
    JSON.stringify({
      id,
      title: 'T',
      status: 'riding',
      createdAt: AT,
      updatedAt: AT,
      allowEdits: false,
      items: [],
      pendingHooks: [fire()],
      ...over,
    }),
  )
}

async function read(id: string) {
  return JSON.parse(
    await readFile(path.join(project.dataDir, `${id}.json`), 'utf8'),
  ) as { items: Item[]; pendingHooks?: PendingHook[]; updatedAt: string }
}

const hookItems = (items: Item[]) =>
  items.filter((i): i is HookItem => i.kind === 'hook')

const dispatch = (
  id: string,
  seams: { resolve?: unknown; run?: unknown },
): Promise<boolean> =>
  dispatchPendingHooks(project, id, {
    api: 'http://localhost:0',
    now: () => AT,
    ...(seams as Record<string, never>),
  })

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'lander-dispatch-'))
  project = {
    path: '/project',
    slug: 'proj',
    dataDir: path.join(root, 'tasks'),
    runsDir: path.join(root, 'runs'),
    archiveDir: path.join(root, 'archived'),
    flowsDir: path.join(root, 'flows'),
    attachmentsDir: path.join(root, 'attachments'),
    hooksFile: path.join(root, 'hooks.json'),
  }
  await mkdir(project.dataDir, { recursive: true })
})

afterEach(async () => {
  clearHookRunState()
  await rm(root, { recursive: true, force: true })
})

describe('dispatchPendingHooks', () => {
  it('runs an approved hook and clears the fire', async () => {
    await writeTask('t1')
    const run = running({ outcome: 'ran', reports: ['would have nudged'] })
    await dispatch('t1', { resolve: resolving([outcome()]), run })

    expect(run).toHaveBeenCalledTimes(1)
    const sent = run.mock.calls[0][0]
    expect(sent).toMatchObject({
      fireId: 'fire-1-abc',
      hook: { path: SUPERVISE, runs: BLOB },
      trigger: { kind: 'ride-ended', by: 'agent', rideId: 'ride-1' },
    })

    const t = await read('t1')
    expect(t.pendingHooks).toBeUndefined()
    expect(hookItems(t.items)).toHaveLength(1)
    expect(hookItems(t.items)[0]).toMatchObject({
      outcome: 'ran',
      text: 'would have nudged',
      hook: 'supervise',
      ride: 'ride-1',
    })
  })

  // Half the selection axis: a fire resolves against its OWN trigger and its own
  // principal, plus `any`. Without asserting the argument, the call site could
  // pass the two swapped, or a hard-coded 'any', and every other test here would
  // still pass — while a hook under `landed/human/` silently never ran.
  it('resolves against the fire’s own trigger and principal', async () => {
    await writeTask('t1', {
      pendingHooks: [fire({ trigger: 'landed', by: 'human', rideId: undefined })],
    })
    const resolve = resolving([])
    await dispatch('t1', { resolve, run: running(null) })
    expect(resolve.mock.calls[0][0].select).toEqual([
      { trigger: 'landed', by: 'human' },
      { trigger: 'landed', by: 'any' },
    ])
  })

  // The ancestry fallback: an unapproved edit sits over an approved ancestor, so
  // what runs is the ancestor. Dispatching the declared blob instead would have
  // the host's own re-check refuse it, and an approved hook would stop running
  // the moment anyone committed an unreviewed edit.
  it('dispatches the blob that may run, not the one the tree declares', async () => {
    await writeTask('t1')
    const ancestor = 'c0ffee1c0ffee1c0ffee1c0ffee1c0ffee1c0ffe'
    const run = running({ outcome: 'ran', reports: [] })
    await dispatch('t1', {
      resolve: resolving([
        outcome({ state: 'pending', runs: ancestor, reason: 'unapproved-version' }),
      ]),
      run,
    })
    expect(run.mock.calls[0][0].hook.runs).toBe(ancestor)
  })

  // A body that ran and found nothing is the common case for a gate with ~80%
  // skip. An item per fire would bury every task's timeline.
  it('leaves no item when a body reports nothing', async () => {
    await writeTask('t1')
    await dispatch('t1', {
      resolve: resolving([outcome()]),
      run: running({ outcome: 'ran', reports: [] }),
    })
    const t = await read('t1')
    expect(hookItems(t.items)).toHaveLength(0)
    expect(t.pendingHooks).toBeUndefined()
  })

  // The first hook a project commits has no approved ancestor by definition, so
  // this state holds for every fire until a human clicks approve. An item here
  // would be the flood the design refuses elsewhere — and NOT marking it done
  // would hold the fire forever, re-resolving every sweep until the age ceiling.
  it('finishes a fire silently when no version is approved', async () => {
    await writeTask('t1')
    const run = running({ outcome: 'ran', reports: [] })
    await dispatch('t1', {
      resolve: resolving([
        outcome({ state: 'pending', runs: null, reason: 'no-approved-version' }),
      ]),
      run,
    })
    const t = await read('t1')
    expect(run).not.toHaveBeenCalled()
    expect(hookItems(t.items)).toHaveLength(0)
    expect(t.pendingHooks).toBeUndefined()
  })

  it('clears a fire that selects no hook at all', async () => {
    await writeTask('t1')
    await dispatch('t1', { resolve: resolving([]), run: running(null) })
    const t = await read('t1')
    expect(t.pendingHooks).toBeUndefined()
    expect(hookItems(t.items)).toHaveLength(0)
  })

  // Holds. Each of these leaves the fire exactly as it was — no attempt, no
  // item — because none of them is the fire's fault and all of them pass.
  it.each([
    ['no daemon connected', { ok: false, status: 503 }],
    ['a dispatch timeout', { ok: false, status: 504 }],
    ['a daemon that threw', { ok: false, status: 500 }],
    ['an unknown credential', { ok: true, report: { outcome: 'credential-unknown', reports: [] } }],
    ['a fire already running', { ok: true, report: { outcome: 'already-running', reports: [] } }],
  ])('holds the fire on %s', async (_label, response) => {
    await writeTask('t1')
    await dispatch('t1', {
      resolve: resolving([outcome()]),
      run: vi.fn(async () => response),
    })
    const t = await read('t1')
    expect(t.pendingHooks).toHaveLength(1)
    expect(t.pendingHooks![0].attempts ?? {}).toEqual({})
    expect(hookItems(t.items)).toHaveLength(0)
  })

  // The boot sweep runs before the daemon reconnects, so this is the state of
  // EVERY `server/**` reload. Counting it would discard the instance's pending
  // fires after five edits.
  it('holds every fire when resolution itself fails', async () => {
    await writeTask('t1')
    const run = running(null)
    await dispatch('t1', { resolve: resolving([], false), run })
    const t = await read('t1')
    expect(run).not.toHaveBeenCalled()
    expect(t.pendingHooks).toHaveLength(1)
  })

  // A body that threw or hung is the fire's own fault: reported, counted, and
  // eventually given up on rather than retried forever.
  it.each(['error', 'timeout'] as const)('counts %s as an attempt', async (o) => {
    await writeTask('t1')
    await dispatch('t1', {
      resolve: resolving([outcome()]),
      run: running({ outcome: o, reports: [], error: 'boom' }),
    })
    const t = await read('t1')
    expect(t.pendingHooks![0].attempts).toEqual({ [SUPERVISE]: 1 })
    expect(hookItems(t.items)[0]).toMatchObject({ outcome: o, error: 'boom' })
  })

  it('gives up after the attempt ceiling, saying so', async () => {
    await writeTask('t1', {
      pendingHooks: [fire({ attempts: { [SUPERVISE]: MAX_HOOK_DISPATCH_ATTEMPTS - 1 } })],
    })
    await dispatch('t1', {
      resolve: resolving([outcome()]),
      run: running({ outcome: 'error', reports: [], error: 'boom' }),
    })
    const t = await read('t1')
    expect(t.pendingHooks).toBeUndefined()
    expect(hookItems(t.items).map((i) => i.outcome)).toEqual([
      'error',
      'dispatch-failed',
    ])
  })

  // A human revoked the approval between dispatch and materialization. Terminal
  // rather than retried: retrying past a revocation is what the button says not
  // to do.
  it('treats a refusal as final', async () => {
    await writeTask('t1')
    await dispatch('t1', {
      resolve: resolving([outcome()]),
      run: running({ outcome: 'refused', reports: [], error: 'not approved' }),
    })
    const t = await read('t1')
    expect(t.pendingHooks).toBeUndefined()
    expect(hookItems(t.items)[0]).toMatchObject({ outcome: 'refused' })
  })

  // "Many hooks per trigger" is a headline property, so the unit of retry has to
  // be (fire, hook): a per-fire retry would re-run the healthy body every time
  // the broken one failed, and a body's own effects are not deduped.
  it('retries only the hook that failed, not its healthy sibling', async () => {
    await writeTask('t1')
    const CLEANUP = '.lander/hooks/ride-ended/any/cleanup.js'
    const run = vi.fn(async (msg: { hook: { path: string } }) =>
      msg.hook.path === CLEANUP
        ? { ok: true, report: { outcome: 'error', reports: [], error: 'boom' } }
        : { ok: true, report: { outcome: 'ran', reports: [] } },
    )
    const resolve = resolving([
      outcome(),
      outcome({ path: CLEANUP, name: 'cleanup' }),
    ])
    await dispatch('t1', { resolve, run })
    expect(run).toHaveBeenCalledTimes(2)

    // Second pass: only the failing one goes again.
    run.mockClear()
    await dispatch('t1', { resolve, run })
    expect(run).toHaveBeenCalledTimes(1)
    expect((run.mock.calls[0][0] as { hook: { path: string } }).hook.path).toBe(
      CLEANUP,
    )
  })

  // A hook must not fire on the work it caused, or a self-review hook re-fires
  // on the landing of the review task it launched.
  it('skips a hook the target was launched by', async () => {
    await writeTask('t1', {
      hookOrigin: { path: SUPERVISE, name: 'supervise', fireId: 'f0', target: 't0' },
    })
    const run = running({ outcome: 'ran', reports: [] })
    await dispatch('t1', { resolve: resolving([outcome()]), run })
    expect(run).not.toHaveBeenCalled()
    const t = await read('t1')
    expect(t.pendingHooks).toBeUndefined()
  })

  // The report lands minutes after the trigger, by which time the target is
  // usually riding again — so it must not push the task to the top of the list
  // for a finding nobody is being asked to act on.
  it('does not bump updatedAt', async () => {
    await writeTask('t1')
    await dispatch('t1', {
      resolve: resolving([outcome()]),
      run: running({ outcome: 'ran', reports: ['something'] }),
    })
    expect((await read('t1')).updatedAt).toBe(AT)
  })

  // Called unawaited from the scheduler sweep, where a rejection would kill the
  // server — and since the fire survives a restart, the same one would re-throw
  // on the next boot, making it a crash loop rather than one bad pass.
  it('never rejects, even when a seam throws', async () => {
    await writeTask('t1')
    await expect(
      dispatch('t1', {
        resolve: vi.fn(async () => {
          throw new Error('disk on fire')
        }),
        run: running(null),
      }),
    ).resolves.toBe(true)
  })

  it('drops a fire nothing could resolve within a day', async () => {
    await writeTask('t1', {
      pendingHooks: [fire({ at: '2025-01-01T00:00:00.000Z' })],
    })
    const run = running(null)
    await dispatch('t1', { resolve: resolving([outcome()]), run })
    const t = await read('t1')
    expect(run).not.toHaveBeenCalled()
    expect(t.pendingHooks).toBeUndefined()
    expect(hookItems(t.items)[0]).toMatchObject({ outcome: 'dispatch-failed' })
  })

  it('runs one dispatch per task at a time', async () => {
    await writeTask('t1')
    let inFlight = 0
    let overlapped = false
    const run = vi.fn(async () => {
      inFlight++
      if (inFlight > 1) overlapped = true
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      return { ok: true, report: { outcome: 'ran', reports: [] } }
    })
    const resolve = resolving([outcome()])
    await Promise.all([
      dispatch('t1', { resolve, run }),
      dispatch('t1', { resolve, run }),
    ])
    expect(overlapped).toBe(false)
  })
})
