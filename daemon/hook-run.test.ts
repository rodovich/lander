import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runHook } from './hook-run'
import type { HookRunMessage } from '../server/protocol'

// The hook supervisor's contract: exactly one report comes back, however the
// host ends. Most of these drive a fake host so the failure modes are reachable
// on demand — but the fd-3 cases spawn a REAL node child, because the whole
// point of moving the event stream off stdout is a property of file descriptors
// that a mocked stream cannot exhibit.

const BASE: HookRunMessage = {
  type: 'hook-run',
  requestId: 'req-1',
  project: 'proj',
  fireId: 'fire-1-abc',
  target: { id: 'tsk-1' },
  trigger: { kind: 'ride-ended', by: 'agent', at: '2026-01-01T00:00:00.000Z' },
  hook: {
    path: '.lander/hooks/ride-ended/any/supervise.js',
    runs: 'b10bb10bb10bb10bb10bb10bb10bb10bb10bb10b',
    name: 'supervise',
    trigger: 'ride-ended',
    by: 'any',
  },
  callback: { api: 'http://localhost:0', project: 'proj', token: 'tok' },
  timeoutMs: 1_000,
  killMs: 2_000,
}

let scratch: string

const deps = (over: Partial<Parameters<typeof runHook>[1]> = {}) => ({
  projectRoot: scratch,
  targetCwd: scratch,
  stateDir: path.join(scratch, 'state'),
  ...over,
})

// A real node child, so fd 3 is a real pipe. `body` runs in the child.
async function fakeHost(body: string): Promise<string> {
  const file = path.join(scratch, `host-${Math.random().toString(36).slice(2)}.mjs`)
  await writeFile(file, body, 'utf8')
  return file
}

const spawnReal = (file: string) => () =>
  spawn(process.execPath, [file], {
    cwd: scratch,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'lander-hookrun-'))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('runHook', () => {
  // The fd-3 protocol end to end, against a real pipe. A test that faked the
  // stream would pass just as happily with the event channel on stdout, which
  // is the arrangement a body's console.log corrupts.
  it('reads a report off fd 3 while the body owns stdout and stderr', async () => {
    const host = await fakeHost(`
      import net from 'node:net'
      // Exactly what a chatty body would do to fd 1 and fd 2.
      console.log('not json, and not on the event channel')
      console.error('progress...')
      const s = new net.Socket({ fd: 3 })
      s.end(JSON.stringify({ outcome: 'ran', reports: ['looked, found nothing'] }) + '\\n', () => process.exit(0))
    `)
    const report = await runHook(BASE, deps({ spawnHost: spawnReal(host) }))
    expect(report.outcome).toBe('ran')
    expect(report.reports).toEqual(['looked, found nothing'])
    // The body's own noise is captured as output, not parsed as an event.
    expect(report.output).toContain('not json')
    expect(report.output).toContain('progress...')
  })

  it('reports a body that threw, with its message', async () => {
    const host = await fakeHost(`
      import net from 'node:net'
      new net.Socket({ fd: 3 }).end(JSON.stringify({ outcome: 'error', reports: [], error: 'boom' }) + '\\n', () => process.exit(0))
    `)
    const report = await runHook(BASE, deps({ spawnHost: spawnReal(host) }))
    expect(report).toMatchObject({ outcome: 'error', error: 'boom' })
  })

  // A host that dies without saying anything must still settle, or the server
  // holds the exchange to its timeout and the fire is retried for no reason.
  it('synthesizes a report when the host exits silently', async () => {
    const host = await fakeHost(`process.exit(3)`)
    const report = await runHook(BASE, deps({ spawnHost: spawnReal(host) }))
    expect(report.outcome).toBe('error')
    expect(report.error).toContain('without reporting')
  })

  // The hard kill is a backstop below the server's wait. A host that ignores its
  // own budget is stopped here.
  it('kills a host that overruns and reports the timeout', async () => {
    const host = await fakeHost(`setInterval(() => {}, 1000)`)
    const report = await runHook(
      { ...BASE, killMs: 300 },
      deps({ spawnHost: spawnReal(host) }),
    )
    expect(report.outcome).toBe('timeout')
    expect(report.durationMs).toBeGreaterThanOrEqual(250)
  })

  // The one that catches the release-on-report mistake: a host that reports and
  // then holds a handle open is still killed, and runHook still settles — so a
  // caller that releases the run when this resolves cannot leave a live process
  // group behind, and cannot pin a draining daemon.
  it('kills a host that reports and then refuses to exit', async () => {
    const host = await fakeHost(`
      import net from 'node:net'
      const s = new net.Socket({ fd: 3 })
      s.write(JSON.stringify({ outcome: 'ran', reports: ['done'] }) + '\\n')
      setInterval(() => {}, 1000)
    `)
    const started = Date.now()
    const report = await runHook(
      { ...BASE, killMs: 400 },
      deps({ spawnHost: spawnReal(host) }),
    )
    // The report it did send wins over the kill: it said what it did.
    expect(report.outcome).toBe('ran')
    expect(report.reports).toEqual(['done'])
    // But it settled only once the process was actually gone.
    expect(Date.now() - started).toBeGreaterThanOrEqual(350)
  })

  it('hands its caller a kill for the whole process group', async () => {
    const host = await fakeHost(`setInterval(() => {}, 1000)`)
    let kill: (() => void) | undefined
    const promise = runHook(
      { ...BASE, killMs: 60_000 },
      deps({ spawnHost: spawnReal(host), onSpawn: (k) => (kill = k) }),
    )
    await new Promise((r) => setTimeout(r, 100))
    expect(kill).toBeTypeOf('function')
    kill!()
    const report = await promise
    expect(report.outcome).toBe('error')
  }, 10_000)

  it('reports rather than throwing when the host cannot be spawned', async () => {
    const report = await runHook(
      BASE,
      deps({
        spawnHost: () => {
          throw new Error('no such binary')
        },
      }),
    )
    expect(report).toMatchObject({ outcome: 'error' })
    expect(report.error).toContain('no such binary')
  })

  it('keeps only the tail of a noisy body', async () => {
    const host = await fakeHost(`
      import net from 'node:net'
      process.stdout.write('x'.repeat(40000))
      process.stdout.write('THE-END')
      new net.Socket({ fd: 3 }).end(JSON.stringify({ outcome: 'ran', reports: [] }) + '\\n', () => process.exit(0))
    `)
    const report = await runHook(BASE, deps({ spawnHost: spawnReal(host) }))
    expect(report.output!.length).toBeLessThanOrEqual(8 * 1024)
    expect(report.output).toContain('THE-END')
  })
})
