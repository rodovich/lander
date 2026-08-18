// The daemon's supervisor for one hook run: spawn a short-lived host, feed it
// the run, collect its single report, and guarantee that exactly one report
// comes back however the host ends.
//
// The body never runs in this process. Hook bodies are user-authored code with
// daemon privileges, and a throw or a hang in-process would take down the owner
// of every in-flight agent run — the same containment reasoning that puts a
// ride's flow in its own host. The in-process `onGrant`/`onStatus` pattern is
// explicitly not the precedent: flow-inversion records that as acceptable only
// while flows are compiled-in and trusted, which a project's hook is not.
//
// Three things about the spawn are load-bearing and were each got wrong first:
//
//   - **The event stream is on fd 3**, not stdout, so a body's `console.log` —
//     or an `inherit`-stdio grandchild it spawns without going through
//     ctx.spawn — cannot land in the middle of a JSON line. A line parser drops
//     what it cannot parse, so sharing fd 1 would fail as a *lost report*,
//     which is the hardest kind to diagnose. Separating the descriptors is
//     structural where a `process.stdout.write` monkeypatch is not: it does
//     nothing to the file descriptor.
//   - **Spawned as `node --import tsx <entry>`, not through the `tsx` bin.**
//     The bin is a wrapper process that re-spawns Node with three stdio
//     entries, so fd 3 on the child is not the pipe opened here. daemon-watch
//     records the same wrapper as a lesson already learned for signals.
//   - **`cwd` is lander's own root**, because `--import tsx` resolves against
//     the child's cwd. Spawning at the project root works in this repository
//     and fails with ERR_MODULE_NOT_FOUND in every other project — silently,
//     since the failure is an exit code and an empty fd 3. The directory the
//     work happens in travels in the input instead, exactly as daemon/run.ts
//     does for the flow host.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { ROOT } from './adapters'
import type { HookRunMessage, HookRunReport } from '../server/protocol'

const HOOK_HOST_ENTRY = path.join(ROOT, 'daemon', 'hook-host.ts')

// How much of the body's own output to keep. Enough to debug a body, bounded so
// a chatty one cannot fill a task record.
const OUTPUT_TAIL_BYTES = 8 * 1024
// The same bound on what a body reports, which is otherwise unbounded.
const MAX_REPORTS = 64
const MAX_REPORT_BYTES = 4 * 1024

export type SpawnHookHostLike = () => ChildProcess

// Everything the host needs, as one JSON line on its stdin.
export type HookHostInput = {
  run: HookRunMessage
  // The project's own root — where the blob is read from, and where a body's
  // ctx.project.root points.
  projectRoot: string
  // The target's checkout, already resolved by the daemon (it owns host paths).
  targetCwd: string
  // A per-project directory the body may keep durable state in.
  stateDir: string
}

export type RunHookDeps = {
  projectRoot: string
  targetCwd: string
  stateDir: string
  spawnHost?: SpawnHookHostLike
  now?: () => number
  // Handed the group kill once the host exists, so the daemon's own
  // killChildren can reach a hook host the way it reaches a run's. Without it a
  // shutdown would leave the body running as an orphan.
  onSpawn?: (kill: () => void) => void
}

function tail(text: string, limit: number): string {
  return text.length > limit ? text.slice(-limit) : text
}

export function runHook(
  msg: HookRunMessage,
  deps: RunHookDeps,
): Promise<HookRunReport> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const spawnHost =
    deps.spawnHost ??
    (() =>
      nodeSpawn(process.execPath, ['--import', 'tsx', HOOK_HOST_ENTRY], {
        // Lander's own root: `--import tsx` resolves against the child's cwd.
        // The project and the target's checkout ride in the input line.
        cwd: ROOT,
        // Its own process group, so the kill below reaches whatever the body
        // spawned rather than just the host.
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      }))

  return new Promise<HookRunReport>((resolve) => {
    const input: HookHostInput = {
      run: msg,
      projectRoot: deps.projectRoot,
      targetCwd: deps.targetCwd,
      stateDir: deps.stateDir,
    }

    let host: ChildProcess
    try {
      host = spawnHost()
    } catch (e) {
      resolve({
        outcome: 'error',
        reports: [],
        error: `failed to spawn hook host: ${e instanceof Error ? e.message : String(e)}`,
        durationMs: now() - startedAt,
      })
      return
    }

    let output = ''
    let reported: HookRunReport | undefined
    // Why we killed the host, when we did — so a kill-triggered close reports
    // the reason rather than a bare failure.
    let killCause: 'timeout' | undefined
    let settled = false

    const killHost = (): void => {
      try {
        if (host.pid) process.kill(-host.pid, 'SIGKILL')
        else host.kill('SIGKILL')
      } catch {
        try {
          host.kill('SIGKILL')
        } catch {}
      }
    }

    // The single place a report leaves this function, whichever of the three
    // sources fires first: the host's own report, the kill timer, or a close
    // with nothing reported.
    const settle = (report: HookRunReport): void => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      resolve({
        ...report,
        ...(output ? { output: tail(output, OUTPUT_TAIL_BYTES) } : {}),
        durationMs: now() - startedAt,
      })
    }

    // The hard kill sits ABOVE the body's own timeout, so a well-behaved host
    // reports its own `timeout` first and this is the backstop for one that
    // cannot. It stays armed until `close`, not until the report arrives: a
    // host that reports and then leaves a handle open (its own socket, a body
    // timer, a grandchild holding fd 1) would otherwise never be released, and
    // with hook runs counted toward the drain that pins a departing daemon.
    const killTimer = setTimeout(() => {
      killCause = 'timeout'
      killHost()
    }, msg.killMs)
    killTimer.unref?.()

    deps.onSpawn?.(killHost)

    host.stdin?.on('error', () => {})
    try {
      host.stdin?.write(JSON.stringify(input) + '\n')
      host.stdin?.end()
    } catch {}

    // The body's own output — its stdout and stderr both, kept only as the tail.
    const capture = (chunk: Buffer): void => {
      output = tail(output + chunk.toString(), OUTPUT_TAIL_BYTES)
    }
    host.stdout?.on('data', capture)
    host.stderr?.on('data', capture)

    // fd 3: the host's event stream, one JSON line carrying its report.
    const events = host.stdio[3]
    let buf = ''
    if (events && 'on' in events) {
      events.on('data', (d: Buffer) => {
        buf += d.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          try {
            const parsed = JSON.parse(line) as HookRunReport
            reported = {
              outcome: parsed.outcome,
              reports: (parsed.reports ?? [])
                .slice(0, MAX_REPORTS)
                .map((r) => tail(String(r), MAX_REPORT_BYTES)),
              ...(parsed.error ? { error: parsed.error } : {}),
            }
          } catch {
            // Not our line. The body cannot write here (its output goes to
            // fd 1/2), so this is a malformed host, which `close` will settle.
          }
        }
      })
      events.on('error', () => {})
    }

    host.on('error', (e) => {
      settle({
        outcome: 'error',
        reports: [],
        error: `error spawning hook host: ${e.message}`,
      })
    })

    // Everything settles here, so a report is guaranteed however the host ends.
    // Resolving on `close` rather than on the report is what lets the caller
    // release the run only once the process group is actually gone.
    host.on('close', (code) => {
      if (reported) return settle(reported)
      if (killCause === 'timeout')
        return settle({
          outcome: 'timeout',
          reports: [],
          error: `the hook body did not finish within ${Math.round(msg.killMs / 1000)}s and was stopped`,
        })
      settle({
        outcome: 'error',
        reports: [],
        error: `the hook host exited (${code ?? 'signal'}) without reporting`,
      })
    })
  })
}
