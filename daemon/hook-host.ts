// The hook host: one short-lived process per fire. It reads a HookHostInput as a
// single JSON line on stdin, re-checks the approval, materializes the blob
// outside every working tree, imports it, calls it under a timeout, and reports
// on fd 3.
//
// It exists so that a hook body — user-authored code with daemon privileges —
// cannot take the daemon down with it. Everything below is written on the
// assumption that the body throws, hangs, writes garbage to stdout, or calls
// `process.exit`, because all four are reachable and none may cost the daemon
// its in-flight runs.
//
// Ordering is the design, in three places:
//
//   1. **Approval is re-checked here**, after the spawn and before anything is
//      read or imported. A dispatch and its run are separated by a process
//      spawn, and a human revoking in that window must be obeyed — otherwise
//      "revoke" means "stop the next one", which is not what the button says.
//   2. **The blob is read from git, never from the filesystem.** What runs is an
//      approved object, and the working tree is not a source of hook code.
//   3. **It is written under the daemon's own temp dir**, never under the
//      project — materializing into a working tree would put an
//      unapproved-until-now module inside the repository the target is editing.
//
// A throw is a report, not a state: there is no ride to exit non-zero, so no
// applyDone wedge and no invisible task holding an unanswerable ask.

import { execFile } from 'node:child_process'
import { spawn as nodeSpawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { HookRunReport } from '../server/protocol'
import { HOOK_ACTION_BOUND } from '../server/tasks'
import type { HookHostInput } from './hook-run'

// The API version a body declares in `meta`. Bumped when the ctx contract
// changes incompatibly; a mismatch fails cleanly rather than calling a body
// written against a different shape.
const HOOK_API = 1

// ── The report channel ─────────────────────────────────────────────────────
//
// fd 3, so fd 1 and fd 2 stay free for the body and its children. Written
// through a socket rather than fs.writeSync so a full pipe backpressures
// instead of throwing, and ended from its callback so the line is flushed
// before the process goes — `write` then `exit` truncates at one pipe buffer.

let reportChannel: net.Socket | null = null

function channel(): net.Socket {
  if (!reportChannel) {
    reportChannel = new net.Socket({ fd: 3 })
    reportChannel.on('error', () => {})
  }
  return reportChannel
}

let sent = false
// The directory the blob was materialized into, removed on the way out. Held at
// module scope because the exit happens inside `report`: `end()`'s callback
// fires within a turn or two, while an `rm` needs a round trip through the
// threadpool, so a `finally` that cleans up AFTER reporting always loses the
// race — which left one abandoned directory containing the hook's source per
// fire, forever. Cleanup goes before the report, not after it.
let materializedDir: string | null = null
// The body's findings so far, at module scope so the crash handlers can report
// what it had already said rather than only the stack that killed it.
const reports: string[] = []

async function report(report: HookRunReport): Promise<void> {
  if (sent) return
  sent = true
  if (materializedDir)
    await rm(materializedDir, { recursive: true, force: true }).catch(() => {})
  const line = JSON.stringify(report) + '\n'
  try {
    channel().end(line, () => process.exit(0))
  } catch {
    process.exit(1)
  }
  // The socket keeps the process alive until end() flushes, so nothing else is
  // needed here; the exit above is the only one on the happy path.
}

// ── Steps ──────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-C', cwd, ...args],
      // A hook module is a source file; this is generous for one.
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve({ ok: !err, stdout: stdout ?? '' }),
    )
    child.stdin?.end('')
  })
}

// Ask the server whether this exact pair may still run. Three answers, and the
// difference between the first two is why this is not a boolean: a revoked
// approval is a human's act, while an unknown credential just means the server
// restarted and is nobody's fault.
async function checkApproval(
  input: HookHostInput,
): Promise<{ ok: true } | { ok: false; outcome: HookRunReport['outcome']; error: string }> {
  const { run } = input
  let res: Response
  try {
    res = await fetch(
      `${run.callback.api}/api/${encodeURIComponent(run.callback.project)}/hooks/materialize`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lander-hook-token': run.callback.token,
        },
        body: JSON.stringify({
          fireId: run.fireId,
          path: run.hook.path,
          blob: run.hook.runs,
        }),
      },
    )
  } catch (e) {
    return {
      ok: false,
      outcome: 'error',
      error: `could not reach the server to re-check approval: ${
        e instanceof Error ? e.message : String(e)
      }`,
    }
  }
  if (res.ok) return { ok: true }
  const body = (await res.json().catch(() => ({}))) as {
    error?: string
    reason?: string
  }
  return {
    ok: false,
    outcome: body.reason === 'credential-unknown' ? 'credential-unknown' : 'refused',
    error: body.error ?? `approval re-check failed (${res.status})`,
  }
}

// ── The context ────────────────────────────────────────────────────────────
//
// Deliberately small: a body needs far less than a driver flow. No `emit`
// (there is no ride), no `state`, no `artifacts`, and no
// ask/wedge/rest/relaunch/land — absent from the surface rather than denied at
// each route, which is why this shape needs no deny floor across every mutating
// path.
//
// Absent is not prevented. A body holds daemon privileges and runs as the same
// OS user as lander; a determined one reaches the API by other means. The narrow
// surface makes the intended path obvious and an unintended one a deliberate
// act. It is not a sandbox, and nothing downstream should be built as if it were.

type HookCtx = ReturnType<typeof buildCtx>

// What a bounded action answers. Named failure modes rather than one `refused`:
// "the hook stopped itself" has to be distinguishable from "the hook found
// nothing", and a credential this server no longer holds is nobody's fault.
export type HookActionResult =
  | { ok: true; deduped?: true }
  | {
      ok: false
      reason: 'bound' | 'wedged' | 'credential-unknown' | 'error'
      error?: string
    }

function buildCtx(input: HookHostInput, reports: string[]) {
  const { run } = input
  let cached: unknown

  // The dedupe key's ordinal, per kind, per INVOCATION — and it advances only
  // when the server accepted the action.
  //
  // Both halves are load-bearing. Minted per invocation, a retry (which is a
  // fresh host process) restarts at zero and so presents the same keys as the
  // original, which is what lets the server recognise a repeat; derived instead
  // from the target's stored actions it would never collide, because the
  // original's entries push the count past them. Advanced only on acceptance,
  // an attempt the server never recorded — a transport failure, or the
  // `credential-unknown` this server answers on every restart — leaves the next
  // action at the same ordinal, where a retry will meet it. Advancing at
  // composition time instead would offset the retry by one and deliver the
  // action twice.
  const ordinals: Record<string, number> = { nudge: 0, land: 0 }

  async function act(
    kind: 'nudge' | 'land',
    explicitKey: string | undefined,
    send: (key: string) => Promise<Response>,
  ): Promise<HookActionResult> {
    const key = explicitKey ?? `${kind}#${ordinals[kind]}`
    let res: Response
    try {
      res = await send(key)
    } catch (e) {
      return {
        ok: false,
        reason: 'error',
        error: `could not reach the server: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      deduped?: boolean
      reason?: string
      error?: string
    }
    if (res.ok && body.ok) {
      // A deduped action still occupies its ordinal: it IS the action the
      // original took, so the next one belongs at the next slot.
      if (!explicitKey) ordinals[kind]++
      return { ok: true, ...(body.deduped ? { deduped: true as const } : {}) }
    }
    const reason =
      body.reason === 'bound' ||
      body.reason === 'wedged' ||
      body.reason === 'credential-unknown'
        ? body.reason
        : 'error'
    // A refusal says so on the timeline whatever the body does with the result.
    // The bound is the mechanism that keeps a runaway visible, so a body that
    // ignores the return value must not be able to make it the quietest thing in
    // the system — it would leave a fire that acted on nothing and said nothing.
    // A dedupe is not reported: a retry correctly no-op'ing is not a finding.
    if (reason === 'bound')
      reports.push(
        `lander refused this hook's ${kind}: it has already acted ` +
          `${HOOK_ACTION_BOUND} times on this task since a human last touched it.`,
      )
    else if (reason === 'wedged')
      reports.push(
        `lander refused this hook's ${kind}: the task is wedged, holding a ` +
          `question for its human.`,
      )
    return {
      ok: false,
      reason,
      error: body.error ?? `the server refused the ${kind} (${res.status})`,
    }
  }

  return {
    target: {
      id: run.target.id,
      project: run.project,
      flow: run.target.flow,
      // Where the target was actually working. A body that inspects the work
      // must use this rather than assuming the project root, or it will examine
      // the wrong checkout and report a confident pass.
      cwd: input.targetCwd,
      worktree: run.target.worktree,
      // The target's public record, fetched once. Lazy because a body that
      // decides from the trigger alone should not pay for a whole item log.
      //
      // NOTE for bodies that read tool calls: `ToolItem.input` is a display
      // projection — one field chosen by priority, whitespace flattened,
      // truncated — and `inputFull` is stored only when it differs. Read
      // `inputFull ?? input`, and know that keys other than the chosen one were
      // discarded at ingestion and are not recoverable here.
      async read(): Promise<unknown> {
        if (cached !== undefined) return cached
        const res = await fetch(
          `${run.callback.api}/api/${encodeURIComponent(run.callback.project)}/tasks/${encodeURIComponent(run.target.id)}`,
          { headers: { 'x-lander-hook-token': run.callback.token } },
        )
        if (!res.ok) throw new Error(`could not read the target (${res.status})`)
        cached = await res.json()
        return cached
      },
    },
    trigger: run.trigger,
    hook: {
      name: run.hook.name,
      path: run.hook.path,
      blob: run.hook.runs,
      fireId: run.fireId,
      trigger: run.hook.trigger,
      by: run.hook.by,
    },
    project: { slug: run.project, root: input.projectRoot },
    // A per-project directory for whatever a body wants to keep across fires.
    // Provided rather than left to the body to guess: the project root is the
    // repository (logs do not belong there) and the server's data layout is not
    // the daemon's to know.
    stateDir: input.stateDir,
    // Processes, with the credential scrubbed from their environment — a child
    // has no business presenting the hook's identity back to lander.
    spawn(
      cmd: string,
      args: string[] = [],
      opts: { cwd?: string; input?: string } = {},
    ): Promise<{ code: number; stdout: string; stderr: string }> {
      return new Promise((resolve) => {
        const env = { ...process.env }
        delete env.LANDER_HOOK_TOKEN
        const child = nodeSpawn(cmd, args, {
          cwd: opts.cwd ?? input.projectRoot,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', (d: Buffer) => {
          stdout += d.toString()
        })
        child.stderr?.on('data', (d: Buffer) => {
          stderr += d.toString()
        })
        child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }))
        child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
        child.stdin?.on('error', () => {})
        child.stdin?.end(opts.input ?? '')
      })
    },
    // Append a finding to the target and drive a turn, without the side effects
    // an ordinary message carries: its wakeup stays armed, an advisory ask
    // survives, and the item is recorded as the hook's rather than the user's.
    //
    // Bounded and deduped by the server, against the target's own record. The
    // three failure modes are named rather than collapsed into one refusal,
    // because "the hook stopped itself" is only distinguishable from "the hook
    // found nothing" if the body can tell them apart too.
    nudge(text: string, opts: { key?: string } = {}): Promise<HookActionResult> {
      return act('nudge', opts.key, (key) =>
        fetch(
          `${run.callback.api}/api/${encodeURIComponent(run.callback.project)}/tasks/${encodeURIComponent(run.target.id)}/messages`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-lander-hook-token': run.callback.token,
            },
            body: JSON.stringify({ message: String(text), key }),
          },
        ),
      )
    },
    // What happened, for the target's timeline. A body that reports nothing
    // leaves no item — the report is the finding, not the fire.
    report(text: string): void {
      reports.push(String(text))
    },
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function readInput(): Promise<HookHostInput> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const line = Buffer.concat(chunks)
    .toString('utf8')
    .split('\n')
    .find((l) => l.trim())
  if (!line) throw new Error('hook-host: no input on stdin')
  return JSON.parse(line) as HookHostInput
}

async function main(): Promise<void> {
  const input = await readInput()
  const { run } = input

  const approval = await checkApproval(input)
  if (!approval.ok) {
    await report({ outcome: approval.outcome, reports, error: approval.error })
    return
  }

  // A worktree shares its repository's object store, so the blob reads from the
  // project root regardless of which tree the target was working in.
  const blob = await git(input.projectRoot, ['cat-file', 'blob', run.hook.runs])
  if (!blob.ok) {
    await report({
      outcome: 'error',
      reports,
      error: `could not read hook blob ${run.hook.runs}`,
    })
    return
  }

  // Under the daemon's own temp dir. Never ctx.scratch (which falls back to the
  // run's cwd) and never anywhere under the project: this is the moment an
  // unapproved-until-now module would otherwise land in a working tree.
  const dir = await mkdtemp(path.join(tmpdir(), 'lander-hook-'))
  materializedDir = dir
  const file = path.join(dir, `${run.hook.name.replace(/[^\w.-]/g, '_')}.mjs`)
  await writeFile(file, blob.stdout, 'utf8')

  try {
    const mod = (await import(pathToFileURL(file).href)) as {
      meta?: { api?: number }
      default?: (ctx: HookCtx) => unknown
    }
    if (mod.meta?.api !== HOOK_API) {
      await report({
        outcome: 'error',
        reports,
        error: `hook declares meta.api ${String(mod.meta?.api)}; this daemon runs api ${HOOK_API}`,
      })
      return
    }
    if (typeof mod.default !== 'function') {
      await report({ outcome: 'error', reports, error: 'hook has no default export' })
      return
    }

    // The body's own budget, below the daemon's hard kill so a well-behaved
    // host reports its overrun rather than being killed for it.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      // Deliberately NOT unref'd. A body that awaits something that never
      // settles holds no handle of its own, so an unref'd timer lets the event
      // loop empty and the host exit silently — which the daemon then has to
      // report as a crash. This timer is the thing that must outlive the body.
      timer = setTimeout(() => resolve('timeout'), run.timeoutMs)
    })
    const outcome = await Promise.race([
      Promise.resolve(mod.default(buildCtx(input, reports))).then(() => 'ran' as const),
      timeout,
    ])
    if (timer) clearTimeout(timer)
    if (outcome === 'timeout')
      await report({
        outcome: 'timeout',
        reports,
        error: `the hook body did not finish within ${Math.round(run.timeoutMs / 1000)}s`,
      })
    else await report({ outcome: 'ran', reports })
  } catch (e) {
    await report({
      outcome: 'error',
      reports,
      error: e instanceof Error ? (e.stack ?? e.message) : String(e),
    })
  }
  // No `finally` cleanup: `report` removes the directory before it exits, which
  // is the only ordering that wins the race against its own process.exit.
}

// Run only when executed as the entry, not when imported by a test.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  // A body can throw asynchronously or reject a floating promise, either of
  // which terminates Node by default — and would take the report with it. These
  // turn both into the report they should have been.
  const fatal = (e: unknown): void => {
    // Carrying `reports` rather than an empty array: a body that reported its
    // finding and then tripped an unhandled rejection has still found the thing,
    // and losing it to the stack that killed the process defeats the point of
    // these handlers.
    void report({
      outcome: 'error',
      reports,
      error: `hook body crashed the host: ${
        e instanceof Error ? (e.stack ?? e.message) : String(e)
      }`,
    })
  }
  process.on('uncaughtException', fatal)
  process.on('unhandledRejection', fatal)
  await mkdir(tmpdir(), { recursive: true }).catch(() => {})
  main().catch(fatal)
}

export { buildCtx, HOOK_API }
