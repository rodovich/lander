import { execFile } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runHook } from './hook-run'
import type { HookRunMessage, HookRunReport } from '../server/protocol'

// The hook host, end to end and for real: a real git repository holding a real
// committed blob, the real `node --import tsx` spawn, a real HTTP server
// answering the approval re-check, and a real hook body.
//
// Everything here is chosen to be real for a reason. The spawn form is real
// because `--import tsx` resolves against the child's cwd, which no unit test
// with a fake host would ever notice. The blob is committed because what runs is
// an approved object and not a file on disk. And the callback is a real server
// because the re-check is the gate the whole increment turns on.

const exec = promisify(execFile)

let repo: string
let stateDir: string
let server: Server
let api: string
// What the fake server answers the materialize check with.
let approval: { status: number; body: Record<string, unknown> }
let materializeCalls: unknown[]

async function git(args: string[], cwd = repo): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args])
  return stdout.trim()
}

// Commit a hook body and return the blob it landed as.
async function commitHook(source: string, name = 'supervise'): Promise<string> {
  const dir = path.join(repo, '.lander', 'hooks', 'ride-ended', 'any')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, `${name}.js`), source, 'utf8')
  await git(['add', '--', `.lander/hooks/ride-ended/any/${name}.js`])
  await git(['commit', '-q', '-m', `hook ${name} ${Math.random()}`])
  return git(['rev-parse', `HEAD:.lander/hooks/ride-ended/any/${name}.js`])
}

function message(blob: string, over: Partial<HookRunMessage> = {}): HookRunMessage {
  return {
    type: 'hook-run',
    requestId: 'req-1',
    project: 'proj',
    fireId: 'fire-1-abc',
    target: { id: 'tsk-1' },
    trigger: {
      kind: 'ride-ended',
      by: 'agent',
      at: '2026-01-01T00:00:00.000Z',
      rideId: 'ride-7',
      outcome: 'done',
    },
    hook: {
      path: '.lander/hooks/ride-ended/any/supervise.js',
      runs: blob,
      name: 'supervise',
      trigger: 'ride-ended',
      by: 'any',
    },
    callback: { api, project: 'proj', token: 'hook-token' },
    timeoutMs: 5_000,
    killMs: 8_000,
    ...over,
  }
}

const run = (msg: HookRunMessage): Promise<HookRunReport> =>
  runHook(msg, { projectRoot: repo, targetCwd: repo, stateDir })

beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'lander-hookhost-repo-'))
  stateDir = await mkdtemp(path.join(tmpdir(), 'lander-hookhost-state-'))
  await git(['init', '-q', '-b', 'main'], repo)
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'Test'])
  await writeFile(path.join(repo, 'README.md'), '# scratch\n', 'utf8')
  await git(['add', '--', 'README.md'])
  await git(['commit', '-q', '-m', 'init'])

  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url?.endsWith('/hooks/materialize')) {
        materializeCalls.push({
          token: req.headers['x-lander-hook-token'],
          body: JSON.parse(body || '{}'),
        })
        res.writeHead(approval.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(approval.body))
        return
      }
      if (req.url?.includes('/tasks/')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: 'tsk-1', title: 'A target', items: [] }))
        return
      }
      res.writeHead(404)
      res.end('{}')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(() => {
  approval = { status: 200, body: { ok: true } }
  materializeCalls = []
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await rm(repo, { recursive: true, force: true })
  await rm(stateDir, { recursive: true, force: true })
})

// Set before the first afterEach runs.
approval = { status: 200, body: { ok: true } }
materializeCalls = []

describe('hook host', () => {
  it('materializes an approved blob, calls it, and reports what it said', async () => {
    const blob = await commitHook(`
      export const meta = { api: 1 }
      export default async function onTurn(ctx) {
        ctx.report('fired for ' + ctx.target.id + ' on ' + ctx.trigger.kind)
        ctx.report('ride ' + ctx.trigger.rideId)
      }
    `)
    const report = await run(message(blob))
    expect(report.outcome).toBe('ran')
    expect(report.reports).toEqual([
      'fired for tsk-1 on ride-ended',
      'ride ride-7',
    ])
    // It asked before it read anything, and it asked about exactly what it was
    // dispatched with.
    expect(materializeCalls).toEqual([
      {
        token: 'hook-token',
        body: {
          fireId: 'fire-1-abc',
          path: '.lander/hooks/ride-ended/any/supervise.js',
          blob,
        },
      },
    ])
  })

  // T7's host half: approval is re-checked HERE, so a revoke between dispatch
  // and materialization stops the body running at all.
  it('refuses to materialize when the re-check says the version is not approved', async () => {
    const blob = await commitHook(`
      export const meta = { api: 1 }
      import { writeFileSync } from 'node:fs'
      writeFileSync(process.env.HOOK_TEST_CANARY ?? '/dev/null', 'ran')
      export default async function onTurn() {}
    `)
    const canary = path.join(stateDir, 'canary.txt')
    process.env.HOOK_TEST_CANARY = canary
    approval = { status: 403, body: { error: 'nope', reason: 'not-approved' } }
    try {
      const report = await run(message(blob))
      expect(report.outcome).toBe('refused')
      // Nothing was imported: top-level code in the module never ran.
      expect(await readFile(canary, 'utf8').catch(() => null)).toBeNull()
    } finally {
      delete process.env.HOOK_TEST_CANARY
    }
  })

  it('distinguishes an unknown credential from a refusal', async () => {
    const blob = await commitHook(`
      export const meta = { api: 1 }
      export default async function onTurn() {}
    `)
    approval = { status: 401, body: { error: 'who?', reason: 'credential-unknown' } }
    const report = await run(message(blob))
    expect(report.outcome).toBe('credential-unknown')
  })

  // T14: the module is written outside every working tree. A body materialized
  // into the project would put unapproved-until-now code in the repository the
  // target is editing.
  it('materializes outside the project working tree', async () => {
    const blob = await commitHook(`
      export const meta = { api: 1 }
      export default async function onTurn(ctx) {
        ctx.report('module at ' + import.meta.url)
      }
    `)
    const report = await run(message(blob))
    const where = report.reports[0]
    expect(where).toBeDefined()
    expect(where).not.toContain(repo)
    expect(where).toContain('lander-hook-')
    // And it cleans up after itself.
    const dir = decodeURIComponent(
      where!.replace('module at file://', '').replace(/\/[^/]+$/, ''),
    )
    expect(await readFile(path.join(dir, 'x')).catch(() => 'gone')).toBe('gone')
  })

  it('fails cleanly on an api mismatch rather than calling the body', async () => {
    const blob = await commitHook(`
      export const meta = { api: 99 }
      export default async function onTurn(ctx) { ctx.report('should not run') }
    `)
    const report = await run(message(blob))
    expect(report.outcome).toBe('error')
    expect(report.error).toContain('meta.api 99')
    expect(report.reports).toEqual([])
  })

  it('fails cleanly when the module has no default export', async () => {
    const blob = await commitHook(`export const meta = { api: 1 }`)
    const report = await run(message(blob))
    expect(report.outcome).toBe('error')
    expect(report.error).toContain('no default export')
  })

  // A throw is a report, not a state. There is no ride to exit non-zero, so
  // nothing wedges the target.
  it('reports a body that throws, keeping what it had already reported', async () => {
    const blob = await commitHook(`
      export const meta = { api: 1 }
      export default async function onTurn(ctx) {
        ctx.report('got this far')
        throw new Error('deliberate')
      }
    `)
    const report = await run(message(blob))
    expect(report.outcome).toBe('error')
    expect(report.error).toContain('deliberate')
    expect(report.reports).toEqual(['got this far'])
  })

  it('reports a body that hangs, at its own budget rather than the hard kill', async () => {
    const blob = await commitHook(`
      export const meta = { api: 1 }
      export default async function onTurn() {
        await new Promise(() => {})
      }
    `)
    const report = await run(message(blob, { timeoutMs: 300, killMs: 10_000 }))
    expect(report.outcome).toBe('timeout')
    // The body's own budget won, so this settled well inside the hard kill.
    expect(report.durationMs).toBeLessThan(8_000)
  }, 15_000)

  it('reports a body that crashes the host asynchronously', async () => {
    const blob = await commitHook(`
      export const meta = { api: 1 }
      export default async function onTurn() {
        setTimeout(() => { throw new Error('async boom') }, 5)
        await new Promise((r) => setTimeout(r, 200))
      }
    `)
    const report = await run(message(blob))
    expect(report.outcome).toBe('error')
    expect(report.error).toContain('async boom')
  })

  it('gives the body a spawn that works and a state dir it can write', async () => {
    const blob = await commitHook(`
      export const meta = { api: 1 }
      import { writeFileSync } from 'node:fs'
      import path from 'node:path'
      export default async function onTurn(ctx) {
        const r = await ctx.spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
        ctx.report('branch=' + r.stdout.trim() + ' code=' + r.code)
        writeFileSync(path.join(ctx.stateDir, 'note.txt'), 'hello')
        ctx.report('root=' + ctx.project.root)
      }
    `)
    const report = await run(message(blob))
    expect(report.outcome).toBe('ran')
    expect(report.reports[0]).toBe('branch=main code=0')
    expect(report.reports[1]).toBe(`root=${repo}`)
    expect(await readFile(path.join(stateDir, 'note.txt'), 'utf8')).toBe('hello')
  })

  it('scrubs the hook credential from what the body spawns', async () => {
    const blob = await commitHook(`
      export const meta = { api: 1 }
      export default async function onTurn(ctx) {
        const r = await ctx.spawn(process.execPath, ['-e', 'process.stdout.write(String(process.env.LANDER_HOOK_TOKEN))'])
        ctx.report('token=' + r.stdout)
      }
    `)
    process.env.LANDER_HOOK_TOKEN = 'super-secret'
    try {
      const report = await run(message(blob))
      expect(report.reports[0]).toBe('token=undefined')
    } finally {
      delete process.env.LANDER_HOOK_TOKEN
    }
  })

  it('lets the body read its target once', async () => {
    const blob = await commitHook(`
      export const meta = { api: 1 }
      export default async function onTurn(ctx) {
        const a = await ctx.target.read()
        const b = await ctx.target.read()
        ctx.report('title=' + a.title + ' same=' + String(a === b))
      }
    `)
    const report = await run(message(blob))
    expect(report.reports[0]).toBe('title=A target same=true')
  })

  // An uncommitted edit is never a candidate, and a blob no commit reaches is
  // not one either — but if one is somehow named, the host must not invent a
  // module for it.
  it('reports rather than running when the blob cannot be read', async () => {
    const report = await run(
      message('0000000000000000000000000000000000000000'),
    )
    expect(report.outcome).toBe('error')
    expect(report.error).toContain('could not read hook blob')
  })
})
