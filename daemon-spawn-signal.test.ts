import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// End-to-end regression test for the drain-signal delivery bug. The supervisor
// used to spawn the daemon via the `tsx` bin — a wrapper process that relays
// only SIGINT/SIGTERM to the real child — and sent the drain signal to the
// wrapper pid, so no daemon ever received it and graceful drain silently never
// worked (unit tests kept passing: they assert kill() is *called*, not that
// the signal lands). These tests exercise the real spawn shape daemon-watch.mjs
// now uses, with a real child process and a real signal. The property under
// test: the pid we kill() is the pid running our SIGUSR2 handler.

const ROOT = path.dirname(fileURLToPath(import.meta.url))

// A minimal .ts entry standing in for daemon/index.ts: installs the drain
// handler, announces readiness, and idles like a daemon (open handles).
const FIXTURE = `
for (const sig of ['SIGUSR1', 'SIGUSR2'] as const)
  process.on(sig, () => { console.log('drain-signal-received'); process.exit(7) })
console.log('probe-ready')
setInterval(() => {}, 60_000)
`

const dir = mkdtempSync(path.join(tmpdir(), 'lander-sigtest-'))
const fixture = path.join(dir, 'signal-probe.ts')
writeFileSync(fixture, FIXTURE)

const children: ChildProcess[] = []
afterAll(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL')
    } catch {}
  }
  // Killing a wrapper orphans its inner child (that asymmetry is what these
  // tests document), so sweep by the fixture-dir prefix — unique to these
  // tests — to catch strays, including ones leaked by earlier failed runs.
  spawn('pkill', ['-f', 'lander-sigtest-'])
  rmSync(dir, { recursive: true, force: true })
})

// Resolve a promise when the child has printed `marker` on stdout.
function waitForStdout(child: ChildProcess, marker: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${JSON.stringify(marker)}; got: ${buf}`)),
      timeoutMs,
    )
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString()
      if (buf.includes(marker)) {
        clearTimeout(timer)
        resolve(buf)
      }
    })
    child.on('exit', () => {
      clearTimeout(timer)
      reject(new Error(`child exited before printing ${JSON.stringify(marker)}; got: ${buf}`))
    })
  })
}

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for exit')), timeoutMs)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

describe('daemon spawn + drain signal delivery', () => {
  it('SIGUSR2 sent to a directly-spawned (node --import tsx) child reaches its handler', async () => {
    // The exact spawn shape from daemon-watch.mjs.
    const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    await waitForStdout(child, 'probe-ready')
    child.kill('SIGUSR2')
    const code = await waitForExit(child)
    // Exit code 7 proves OUR handler ran in the process we signaled — the whole
    // point: no wrapper sits between kill() and the handler.
    expect(code).toBe(7)
  }, 30_000)

  it('documents the old bug: SIGUSR1 to the tsx bin wrapper never reaches the child', async () => {
    // The historical shape: spawn via the tsx bin (a wrapper process) and send
    // SIGUSR1, as daemon-watch did until 1312bfc. Node reserves SIGUSR1 for the
    // inspector, so the wrapper neither dies nor relays it — it just arms a
    // debugger — and the child's handler (which the probe installs, like the
    // real daemon did) never fires. (SIGUSR2 to the wrapper is a different
    // failure: default disposition kills the wrapper and strands the child —
    // either way, no graceful drain through a wrapper.)
    const tsxBin = path.join(ROOT, 'node_modules', '.bin', 'tsx')
    const wrapper = spawn(tsxBin, [fixture], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(wrapper)
    const seen = waitForStdout(wrapper, 'drain-signal-received', 1_200)
    await waitForStdout(wrapper, 'probe-ready')
    wrapper.kill('SIGUSR1')
    let exited = false
    wrapper.on('exit', () => {
      exited = true
    })
    // The probe must NOT report the signal and the wrapper must NOT exit.
    await expect(seen).rejects.toThrow(/timed out/)
    expect(exited).toBe(false)
    // Cleanup through the one signal tsx does relay.
    wrapper.kill('SIGTERM')
    await waitForExit(wrapper).catch(() => {})
  }, 30_000)
})
