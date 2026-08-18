import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runHook } from './hook-run'
import type { HookRunMessage, HookRunReport } from '../server/protocol'

// The shipped supervision hook, exercised through the real host against fixture
// task records.
//
// Driven end to end rather than by importing the body, and that is deliberate: a
// hook is a single file in the project's own tree, which the design explicitly
// invites tasks to edit and which cannot import a shared module. Importing it
// here would either make `npm test` depend on user-editable content in a way
// that hides drift, or force a second copy of the gate that silently diverges
// from the one that actually runs. Going through runHook costs the same and
// exercises the host and the approval re-check on the way.

const exec = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOOK_SOURCE = path.join(
  ROOT,
  '.lander',
  'hooks',
  'ride-ended',
  'any',
  'supervise.js',
)

const AT = '2026-01-01T12:00:00.000Z'
const BEFORE = '2026-01-01T11:00:00.000Z'
const AFTER = '2026-01-01T13:00:00.000Z'

let repo: string
let stateDir: string
let server: Server
let api: string
let blob: string
let target: Record<string, unknown>

const user = (id: string, text: string, at = BEFORE, over = {}) => ({
  id,
  at,
  kind: 'message',
  role: 'user',
  text,
  ...over,
})
const flow = (id: string, rideId: string, text: string, at = BEFORE, over = {}) => ({
  id,
  at,
  rideId,
  kind: 'message',
  role: 'flow',
  text,
  ...over,
})
const event = (id: string, eventKind: string, at = BEFORE) => ({
  id,
  at,
  kind: 'event',
  eventKind,
})

function message(rideId = 'ride-1'): HookRunMessage {
  return {
    type: 'hook-run',
    requestId: 'req-1',
    project: 'proj',
    fireId: `fire-${Math.random().toString(36).slice(2)}`,
    target: { id: 'tsk-1' },
    trigger: { kind: 'ride-ended', by: 'agent', at: AT, rideId, outcome: 'done' },
    hook: {
      path: '.lander/hooks/ride-ended/any/supervise.js',
      runs: blob,
      name: 'supervise',
      trigger: 'ride-ended',
      by: 'any',
    },
    callback: { api, project: 'proj', token: 'tok' },
    timeoutMs: 10_000,
    killMs: 15_000,
  }
}

const run = (rideId = 'ride-1'): Promise<HookRunReport> =>
  runHook(message(rideId), { projectRoot: repo, targetCwd: repo, stateDir })

// The one line the body wrote for this fire.
async function loggedRows(): Promise<Record<string, unknown>[]> {
  const files = await readdir(stateDir).catch(() => [])
  const rows: Record<string, unknown>[] = []
  for (const f of files) {
    const text = await readFile(path.join(stateDir, f), 'utf8')
    for (const line of text.split('\n').filter(Boolean)) rows.push(JSON.parse(line))
  }
  return rows
}

beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'lander-supervise-repo-'))
  const git = (args: string[]) => exec('git', ['-C', repo, ...args])
  await git(['init', '-q', '-b', 'main'])
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'Test'])
  const dir = path.join(repo, '.lander', 'hooks', 'ride-ended', 'any')
  await mkdir(dir, { recursive: true })
  // The file this repository actually ships, so a change to it fails here.
  await writeFile(
    path.join(dir, 'supervise.js'),
    await readFile(HOOK_SOURCE, 'utf8'),
  )
  await git(['add', '--', '.lander/hooks/ride-ended/any/supervise.js'])
  await git(['commit', '-q', '-m', 'hook'])
  const { stdout } = await git([
    'rev-parse',
    'HEAD:.lander/hooks/ride-ended/any/supervise.js',
  ])
  blob = stdout.trim()

  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      // The approval re-check and the target read share this stub; only the
      // latter needs a payload.
      res.end(
        req.url?.endsWith('/hooks/materialize')
          ? '{"ok":true}'
          : JSON.stringify(target),
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'lander-supervise-state-'))
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await rm(repo, { recursive: true, force: true })
})

describe('the supervision hook', () => {
  // Each predicate on its own, so a change to one is visible.
  it.each([
    [
      'land-instruction',
      'Fix the parser and then land.',
      'Fixed the parser.',
    ],
    [
      'offer-to-continue',
      'Fix the parser.',
      'Fixed the parser. Want me to continue with the tests?',
    ],
    [
      'enumerated',
      'Please:\n1. fix the parser\n2. add a test\n',
      'Fixed the parser.',
    ],
  ])('fires on %s', async (predicate, instruction, closing) => {
    target = {
      id: 'tsk-1',
      status: 'resting',
      items: [user('u1', instruction), flow('f1', 'ride-1', closing)],
    }
    const report = await run()
    expect(report.outcome).toBe('ran')
    expect(report.reports[0]).toContain(predicate)
    // It says plainly that it did not act.
    expect(report.reports[0]).toContain('not armed')

    const rows = await loggedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].matched).toEqual([predicate])
  })

  // The ~80% the gate skips. They still get a row — recall cannot be computed
  // from the positive class alone.
  it('stays silent on a clean segment, and still logs it', async () => {
    target = {
      id: 'tsk-1',
      status: 'resting',
      items: [user('u1', 'Fix the parser.'), flow('f1', 'ride-1', 'Fixed it.')],
    }
    const report = await run()
    expect(report.outcome).toBe('ran')
    expect(report.reports).toEqual([])

    const rows = await loggedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].matched).toEqual([])
  })

  // Per Appendix A the unit is the segment, and a segment can hold several
  // rides. Judging per ride would multiply every measured rate.
  it('judges the segment once, at the ride that closes it', async () => {
    target = {
      id: 'tsk-1',
      status: 'resting',
      items: [
        user('u1', 'Please:\n1. fix the parser\n2. add a test\n'),
        flow('f1', 'ride-1', 'Working on it.'),
        flow('f2', 'ride-2', 'Done with the parser.'),
      ],
    }
    // The first ride of the segment: not the closing one, so no judgment.
    const first = await run('ride-1')
    expect(first.reports).toEqual([])
    expect((await loggedRows())[0].skipped).toBe('segment-open')

    stateDir = await mkdtemp(path.join(tmpdir(), 'lander-supervise-state-'))
    const second = await run('ride-2')
    expect(second.reports[0]).toContain('enumerated')
  })

  // A segment whose next instruction has been queued but not read is still open.
  it('skips while the target has an unread follow-up', async () => {
    target = {
      id: 'tsk-1',
      status: 'resting',
      items: [
        user('u1', 'Fix the parser and then land.'),
        flow('f1', 'ride-1', 'Fixed it.'),
        user('u2', 'also the lexer', AFTER, { queued: true }),
      ],
    }
    const report = await run()
    expect(report.reports).toEqual([])
    expect((await loggedRows())[0].skipped).toBe('segment-open')
  })

  it('skips the ride that landed the task', async () => {
    target = {
      id: 'tsk-1',
      status: 'landed',
      items: [
        user('u1', 'Fix the parser and then land.'),
        flow('f1', 'ride-1', 'Fixed it, landing.'),
        event('e1', 'landed'),
      ],
    }
    const report = await run()
    expect(report.reports).toEqual([])
    expect((await loggedRows())[0].skipped).toBe('landed')
  })

  // A fire is dispatched a sweep plus a body's runtime after its trigger, so the
  // record has usually moved on. Judging the live record would discard the case
  // whose label matters most — a human replying inside that window.
  it('judges as of the fire, not as of the read, and says which it was', async () => {
    target = {
      id: 'tsk-1',
      status: 'riding',
      items: [
        user('u1', 'Fix the parser and then land.'),
        flow('f1', 'ride-1', 'Fixed it. Want me to continue?'),
        // The human replied while the fire was in flight. That opens a NEW
        // segment; the one being judged is unaffected.
        user('u2', 'yes please', AFTER),
        flow('f2', 'ride-2', 'On it.', AFTER),
      ],
    }
    const report = await run()
    expect(report.reports[0]).toContain('offer-to-continue')
    const rows = await loggedRows()
    expect(rows[0].live).toBe(false)
  })

  // A body's own effects are not deduped by the platform, and error/timeout are
  // the two outcomes that retry — so without this the dataset would over-count
  // exactly the fires that had trouble.
  it('writes one row per fire even when the body runs twice', async () => {
    target = {
      id: 'tsk-1',
      status: 'resting',
      items: [user('u1', 'Fix it.'), flow('f1', 'ride-1', 'Fixed.')],
    }
    const msg = message()
    const deps = { projectRoot: repo, targetCwd: repo, stateDir }
    await runHook(msg, deps)
    await runHook(msg, deps)
    expect(await loggedRows()).toHaveLength(1)
  })

  it('reports nothing at all for a ride it cannot locate', async () => {
    target = { id: 'tsk-1', status: 'resting', items: [] }
    const report = await run('ride-missing')
    expect(report.outcome).toBe('ran')
    expect(report.reports).toEqual([])
    expect((await loggedRows())[0].skipped).toBe('no-segment')
  })
})
