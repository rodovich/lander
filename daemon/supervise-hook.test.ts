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

// Takes a whole message when a test needs the SAME fire twice — a retry
// presents the same fire id, which is what the verdict cache keys on.
const run = (
  rideOrMessage: string | HookRunMessage = 'ride-1',
): Promise<HookRunReport> =>
  runHook(
    typeof rideOrMessage === 'string' ? message(rideOrMessage) : rideOrMessage,
    { projectRoot: repo, targetCwd: repo, stateDir },
  )

// The one line the body wrote for this fire.
async function loggedRows(): Promise<Record<string, unknown>[]> {
  // Only the log. The body also keeps its verdict cache in this directory, and
  // reading every file here would parse that as a row.
  const files = (await readdir(stateDir).catch(() => [])).filter((f) =>
    /^supervise-.*\.jsonl$/.test(f),
  )
  const rows: Record<string, unknown>[] = []
  for (const f of files) {
    const text = await readFile(path.join(stateDir, f), 'utf8')
    for (const line of text.split('\n').filter(Boolean)) rows.push(JSON.parse(line))
  }
  return rows
}

beforeAll(async () => {
  await installFakeJudge()
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
      // Every path the body called, so a test can assert what it did NOT do.
      calledPaths.push(`${req.method} ${req.url}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      // The approval re-check and the target read share this stub; only the
      // latter needs a payload.
      // `flow` decides which provider ctx.assist reaches for, so it defaults
      // here rather than in every fixture; a test about provider resolution
      // overrides it.
      res.end(
        req.url?.endsWith('/hooks/materialize')
          ? '{"ok":true}'
          : JSON.stringify({ flow: 'claude', ...target }),
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

// A stand-in for the provider `ctx.assist` shells out to.
//
// The body now calls a model, and `runHook` spawns a real host — so without this
// `npm test` would make a paid network call, need credentials, and answer
// differently every run. The host inherits this process's environment, so
// putting a fake `claude` first on PATH is enough; `bin/lander-assist.test.ts`
// seams the same way. `verdict` is what that fake will say next.
let judgeBin: string
let judgeCalls: string
let calledPaths: string[] = []
// Reset before every test. Held as a constant rather than a mutable default, or
// a test that sets its own verdict leaks it into every test after it.
const DEFAULT_VERDICT =
  'VERDICT: unfinished\nBECAUSE: the second item was never done.'

async function installFakeJudge(): Promise<void> {
  judgeBin = await mkdtemp(path.join(tmpdir(), 'lander-supervise-bin-'))
  judgeCalls = path.join(judgeBin, 'calls.log')
  const script = path.join(judgeBin, 'claude')
  // Records the prompt it was given, then prints whatever the test set. Reading
  // `verdict` from a file rather than baking it in keeps the fake constant while
  // the answer varies.
  await writeFile(
    script,
    [
      '#!/bin/sh',
      // A one-line marker per invocation, so calls can be counted without the
      // prompt's own newlines being mistaken for more of them.
      `printf '===CALL===\\n%s\\n' "$*" >> ${JSON.stringify(judgeCalls)}`,
      `cat ${JSON.stringify(path.join(judgeBin, 'verdict.txt'))}`,
    ].join('\n'),
    { mode: 0o755 },
  )
  process.env.PATH = `${judgeBin}${path.delimiter}${process.env.PATH ?? ''}`
}

const setVerdict = (text: string): Promise<void> =>
  writeFile(path.join(judgeBin, 'verdict.txt'), text)

const judgePrompts = (): Promise<string> =>
  readFile(judgeCalls, 'utf8').catch(() => '')

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'lander-supervise-state-'))
  await rm(judgeCalls, { force: true })
  await setVerdict(DEFAULT_VERDICT)
  calledPaths = []
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await rm(repo, { recursive: true, force: true })
  await rm(judgeBin, { recursive: true, force: true })
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
  ])('gates on %s, then judges', async (predicate, instruction, closing) => {
    target = {
      id: 'tsk-1',
      status: 'resting',
      flow: 'claude',
      items: [user('u1', instruction), flow('f1', 'ride-1', closing)],
    }
    const report = await run()
    expect(report.outcome, report.error).toBe('ran')
    expect(report.reports[0]).toContain(predicate)
    // The verdict, and the fact that nothing was sent on the strength of it.
    expect(report.reports[0]).toContain('unfinished')
    expect(report.reports[0]).toContain('not acting on them')

    const rows = await loggedRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].matched).toEqual([predicate])
    expect(rows[0].verdict).toBe('unfinished')
  })

  // Nothing is armed, and nothing asserts it otherwise: the stub answers 200 to
  // every path, so a stray ctx.nudge would be swallowed as a body error and no
  // other assertion in this file would move. This is the one that would.
  it('takes no action, on the segment most likely to provoke one', async () => {
    target = {
      id: 'tsk-1',
      status: 'resting',
      flow: 'claude',
      items: [
        user('u1', 'Fix the parser and then land.'),
        flow('f1', 'ride-1', 'Fixed it. Want me to continue with the tests?'),
      ],
    }
    const report = await run()
    expect(report.outcome, report.error).toBe('ran')
    // It judged, and said so.
    expect(report.reports[0]).toContain('unfinished')
    // And reached neither action verb.
    expect(calledPaths.filter((p) => p.includes('/messages'))).toEqual([])
    expect(calledPaths.filter((p) => p.startsWith('PATCH'))).toEqual([])
  })

  // Without this the same finding is re-judged and re-reported on every later
  // ride under one instruction, and the runaway bound becomes the routine
  // terminating condition rather than the backstop it is.
  it('skips a segment it has already nudged', async () => {
    target = {
      id: 'tsk-1',
      status: 'resting',
      flow: 'claude',
      items: [
        user('u1', 'Fix the parser and then land.'),
        flow('f1', 'ride-0', 'Fixed it.'),
        {
          id: 'h1',
          at: BEFORE,
          kind: 'message',
          role: 'hook',
          text: 'From hook supervise:\n\nreally finished?',
          from: {
            hook: 'supervise',
            path: '.lander/hooks/ride-ended/any/supervise.js',
            fireId: 'fire-earlier',
          },
        },
        flow('f2', 'ride-1', 'Yes, done.'),
      ],
    }
    const report = await run()
    expect(report.reports).toEqual([])
    expect((await loggedRows())[0].skipped).toBe('already-nudged')
    // And it did not pay for a judge to reach that conclusion.
    expect(await judgePrompts()).toBe('')
  })

  // A nudge from a DIFFERENT hook is not this one's own, so it must not suppress
  // this one — the guard keys on the path, which is a hook's identity.
  it('does not treat another hook’s nudge as its own', async () => {
    target = {
      id: 'tsk-1',
      status: 'resting',
      flow: 'claude',
      items: [
        user('u1', 'Fix the parser and then land.'),
        flow('f1', 'ride-0', 'Fixed it.'),
        {
          id: 'h1',
          at: BEFORE,
          kind: 'message',
          role: 'hook',
          text: 'From hook other:\n\nsomething else',
          from: {
            hook: 'other',
            path: '.lander/hooks/ride-ended/any/other.js',
            fireId: 'fire-other',
          },
        },
        flow('f2', 'ride-1', 'Yes, done.'),
      ],
    }
    await run()
    expect((await loggedRows())[0].skipped).toBeUndefined()
  })

  // §1: a verdict must not rest on the agent's self-report. The gate may use it
  // — offer-to-continue reads exactly that prose — but the judge is handed the
  // instruction as well, and is told the inputs are complete.
  it('hands the judge the instruction, not only the closing message', async () => {
    target = {
      id: 'tsk-1',
      status: 'resting',
      flow: 'claude',
      items: [
        user('u1', 'Fix the parser and then land.'),
        flow('f1', 'ride-1', 'Fixed the parser.'),
      ],
    }
    await run()
    const prompt = await judgePrompts()
    expect(prompt).toContain('Fix the parser and then land.')
    expect(prompt).toContain('Fixed the parser.')
    expect(prompt).toContain('Do not use tools')
  })

  // hooks.md §9's one platform-level rule for any judging body.
  it('treats a verdict it cannot parse as inert', async () => {
    await setVerdict('I think it probably did most of it, hard to say really.')
    target = {
      id: 'tsk-1',
      status: 'resting',
      flow: 'claude',
      items: [
        user('u1', 'Fix the parser and then land.'),
        flow('f1', 'ride-1', 'Fixed the parser.'),
      ],
    }
    const report = await run()
    expect(report.outcome, report.error).toBe('ran')
    // Nothing reported, because nothing was concluded.
    expect(report.reports).toEqual([])
    const rows = await loggedRows()
    expect(rows[0]).toMatchObject({ verdict: 'unclear', unparseable: true })
  })

  // A task that stopped to ask its human something it cannot answer itself is
  // waiting on a person, not idling — and it is the shape the offer-to-continue
  // predicate matches most often, so a judge that got this wrong would nudge
  // exactly the tasks that were behaving correctly.
  it('records a finished verdict without reporting anything', async () => {
    await setVerdict('VERDICT: finished\nBECAUSE: it is waiting on a decision only its human can make.')
    target = {
      id: 'tsk-1',
      status: 'resting',
      flow: 'claude',
      items: [
        user('u1', 'Fix the parser.'),
        flow('f1', 'ride-1', 'Fixed it. Want me to continue with the tests?'),
      ],
    }
    const report = await run()
    expect(report.reports).toEqual([])
    const rows = await loggedRows()
    expect(rows[0].verdict).toBe('finished')
  })

  // An assist is a direct body effect, which the platform's retry dedupe does
  // not cover: without the cache a fire that failed after judging would pay for
  // the model again on each of up to five attempts.
  it('reuses its verdict rather than re-judging when a fire is retried', async () => {
    target = {
      id: 'tsk-1',
      status: 'resting',
      flow: 'claude',
      items: [
        user('u1', 'Fix the parser and then land.'),
        flow('f1', 'ride-1', 'Fixed the parser.'),
      ],
    }
    const msg = message()
    await run(msg)
    await run(msg) // the same fire, re-dispatched
    expect((await judgePrompts()).match(/===CALL===/g) ?? []).toHaveLength(1)
  })

  // The provider is the target's. A target on an announced flow declares none,
  // so the body reports that judgment was unavailable rather than guessing.
  it('does not judge a target whose flow declares no provider', async () => {
    target = {
      id: 'tsk-1',
      status: 'resting',
      flow: 'open-pr',
      items: [
        user('u1', 'Fix the parser and then land.'),
        flow('f1', 'ride-1', 'Fixed the parser.'),
      ],
    }
    const report = await run()
    expect(report.outcome, report.error).toBe('ran')
    expect(await judgePrompts()).toBe('')
    const rows = await loggedRows()
    expect(rows[0].verdict).toBe('unavailable')
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
  //
  // The later ride is stamped AFTER the fire, which is the only way it can
  // happen: a ride that follows this one necessarily starts after this one
  // closed, and the fire's `at` IS that close. An earlier draft of this test
  // dated it before the fire, which made the fixture temporally impossible —
  // and hid that the body was truncating the record at `trigger.at`, so
  // `isLast` was true for 3,129 of 3,129 real rides and the segment guard did
  // nothing at all.
  it('judges the segment once, at the ride that closes it', async () => {
    target = {
      id: 'tsk-1',
      status: 'resting',
      items: [
        user('u1', 'Please:\n1. fix the parser\n2. add a test\n'),
        flow('f1', 'ride-1', 'Working on it.'),
        flow('f2', 'ride-2', 'Done with the parser.', AFTER),
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

  // The mirror image, and the one that matters most: a human replying inside
  // the dispatch window ENDS this segment rather than reopening it. Skipping
  // here would discard the ground-truth positive — "a human had to nudge" is
  // the label the whole exercise exists to collect — and would do it on a race
  // between the queue drain and this body's read.
  it('still judges a segment a human replied to while the fire was in flight', async () => {
    target = {
      id: 'tsk-1',
      status: 'riding',
      items: [
        user('u1', 'Fix the parser and then land.'),
        flow('f1', 'ride-1', 'Fixed it.'),
        user('u2', 'also the lexer', AFTER, { queued: true }),
      ],
    }
    const report = await run()
    expect(report.reports[0]).toContain('land-instruction')
    const rows = await loggedRows()
    expect(rows[0].matched).toEqual(['land-instruction'])
    // …and it says the record had moved on, so a later reading can tell.
    expect(rows[0].live).toBe(false)
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
  it('judges the segment the reply ended, not the one it started', async () => {
    target = {
      id: 'tsk-1',
      status: 'riding',
      items: [
        user('u1', 'Fix the parser.'),
        flow('f1', 'ride-1', 'Fixed it. Want me to continue?'),
        // The human replied and the task went back to work. The span being
        // judged is bounded by that reply, so the later ride is a different
        // segment and its closing message is not this one's.
        user('u2', 'yes please', AFTER),
        flow('f2', 'ride-2', 'On it, no questions here.', AFTER),
      ],
    }
    const report = await run()
    expect(report.reports[0]).toContain('offer-to-continue')
    const rows = await loggedRows()
    expect(rows[0].closingFirstLine).toBe('Fixed it. Want me to continue?')
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
