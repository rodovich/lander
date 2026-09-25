// The contract harness: lander's real flows, runtime and server fold, driven
// against the real agent CLIs.
//
// driveLive is the regression harness (daemon/flows/testCtx.ts driveFlow) with
// one seam swapped: the child is a real process instead of a replayed golden.
// Everything lander does on either side of the CLI — argv, prompt assembly,
// stream reduction, the flow's state writes, the server's fold — is the
// production code, so an assertion on the folded task checks the integration,
// not a hand-copied flag list. runJsonl covers the CLI facts that no lander code
// path exercises yet.

import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCtxRuntime, type Ctx, type TurnResult } from '../daemon/flows/ctx'
import { applyEvents } from '../daemon/flows/testTask'
import type { HostEvent } from '../daemon/host-protocol'
import type { StartRunMessage } from '../server/protocol'
import type { Ride } from '../server/tasks'

const ROOT = path.resolve(import.meta.dirname, '..')

// The production task prompt, so probe turns carry what real turns carry.
export const TASK_PROMPT = readFileSync(path.join(ROOT, 'server', 'task-prompt.md'), 'utf8').trim()

// The version a CLI reports, or undefined when it isn't installed. Suites skip
// themselves on undefined and name the version they ran against otherwise.
export function cliVersion(cmd: string): string | undefined {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : undefined
}

// A fresh directory under the OS temp root; `git: true` makes it a repo, which
// both CLIs treat as a trusted workspace. realpath'd so paths the CLIs report
// (macOS resolves /var to /private/var) compare equal.
export function scratchDir({ git }: { git: boolean }): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'lander-contract-')))
  if (git) spawnSync('git', ['init', '-q'], { cwd: dir })
  return dir
}

// A `lander` stand-in for the Claude flow's hooks and allow rule. The real
// binary would post the probe's cwd and worktree to a server; this one exits 0.
export function landerStub(): string {
  const dir = path.join(scratchDir({ git: false }), 'bin')
  mkdirSync(dir)
  const bin = path.join(dir, 'lander')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n')
  chmodSync(bin, 0o755)
  return bin
}

// The run env a daemon would hand the flow, pointed at nothing: a flow that
// tried to orchestrate over the task API would fail fast rather than reach a
// live server.
const INERT_ENV = {
  LANDER_API: 'http://127.0.0.1:9',
  LANDER_TOKEN: 'contract',
  LANDER_TASK: 'contract-task',
  LANDER_PROJECT: 'contract',
}

export type LiveTurn = {
  // The task as the server would store it after this turn.
  task: Record<string, unknown> & { rides?: Ride[]; flowState?: Record<string, unknown> }
  ride: Ride
  events: HostEvent[]
  result: TurnResult
}

let runSeq = 0

// Run one turn of `flow` for real in `root`. Pass the previous turn's folded
// task as `prior` to resume: its session and flow state ride in on start-run,
// exactly as the server sends them.
export async function driveLive(
  flow: { onTurn(ctx: Ctx): Promise<TurnResult> },
  opts: {
    root: string
    prompt: string
    prior?: LiveTurn['task']
    allowEdits?: boolean
    // Task-scope grants, as the server sends them from the task's allow list.
    allow?: string[]
  },
): Promise<LiveTurn> {
  const prior = opts.prior
  const start = {
    type: 'start-run',
    runId: `contract-run-${++runSeq}`,
    taskId: 'contract-task',
    project: 'contract',
    prompt: opts.prompt,
    task: {
      allowEdits: opts.allowEdits ?? false,
      ...(opts.allow ? { allow: opts.allow } : {}),
    },
    env: INERT_ENV,
    idleTimeoutMs: 600_000,
    ...(prior?.sessionId ? { sessionId: prior.sessionId } : {}),
    ...(prior?.turnContext ? { turnContext: prior.turnContext } : {}),
    ...(prior?.flowState ? { flowState: prior.flowState } : {}),
    ...(prior?.flowStateRev !== undefined ? { flowStateRev: prior.flowStateRev } : {}),
  } as StartRunMessage
  const events: HostEvent[] = []
  const runtime = createCtxRuntime(
    { start, root: opts.root, cwd: opts.root },
    { emit: (e) => events.push(e), spawn, onStderr: () => {} },
  )
  await runtime.runTurn(flow)
  const done = events.find((e) => e.kind === 'done') as
    | Extract<HostEvent, { kind: 'done' }>
    | undefined
  const task = applyEvents(start, events) as LiveTurn['task']
  return {
    task,
    ride: task.rides!.at(-1)!,
    events,
    result: { exitCode: done?.exitCode ?? null, stderr: done?.stderr ?? '' } as TurnResult,
  }
}

// The reply text a turn produced (the fold carries it on the last flow message).
export function replyText(turn: LiveTurn): string {
  const items = (turn.task.items ?? []) as { kind: string; role?: string; text?: string }[]
  return items
    .filter((it) => it.kind === 'message' && it.role !== 'user')
    .map((it) => it.text ?? '')
    .join('\n')
}

export type JsonlRun = { lines: Record<string, any>[]; exit: number | null; stderr: string }

// Run a CLI to completion with stdin closed and parse its JSONL stdout, keeping
// only the lines that parse.
export function runJsonl(cmd: string, args: string[], opts: { cwd: string }): JsonlRun {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 170_000,
  })
  const lines: Record<string, any>[] = []
  for (const line of (r.stdout ?? '').split('\n')) {
    try {
      lines.push(JSON.parse(line))
    } catch {}
  }
  return { lines, exit: r.status, stderr: r.stderr ?? '' }
}
