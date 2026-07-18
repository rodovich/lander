// The flow host: one subprocess per run. It reads a HostInput as a single JSON
// line on stdin, runs the adapter executor (runAgent) against the compiled-in
// adapters, and streams neutral HostEvents back as line-JSON on stdout. The agent
// grandchild's stdout is reduced by runAgent and never leaks here; its stderr is
// relayed to this process's stderr so the daemon's idle watchdog sees the activity
// through the boundary (decision 6). On any exit it kills its agent child so a
// killed host leaves no orphan.
//
// The daemon spawns one of these per run (daemon/run.ts). Because it lives under
// daemon/, daemon-watch reloads the daemon on edits to it.
//
// The adapter's outgoing steps are routed through the ctx runtime's identity
// minter (the compatibility bridge), so tool/group ids on the wire are Lander's
// rather than the provider's even while the compiled adapters still execute the
// turn. That lands ahead of either cutover on purpose: it makes the adapter
// oracle and the ported flow mint identical ids, which is what the parity
// harness's whole-task-JSON deep-equal rests on.

import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentAdapter } from './agent'
import type { AgentKind } from '../server/protocol'
import { buildAdapters, ROOT } from './adapters'
import {
  runAgent,
  type HostEvent,
  type HostInput,
  type SpawnLike,
} from './run-agent'
import { createCtxRuntime } from './flows/ctx'
import { createAdapterBridge } from './flows/adapter-bridge'

// Serialize one neutral event as a JSON line on stdout — the host → daemon wire.
export function emitLine(event: HostEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n')
}

export type RunHostDeps = {
  emit: (event: HostEvent) => void
  spawn?: SpawnLike
  mintSessionId?: () => string
  now?: () => string
  onStderr?: (chunk: string) => void
  // Injectable so tests run against test-configured adapters; defaults to the real
  // compiled-in claude/codex adapters (proving buildAdapters wires the host).
  adapters?: Partial<Record<AgentKind, AgentAdapter>>
}

// Wire the executor with the host's seam: emit serializes to the daemon, `arm` is a
// no-op (idle activity is the daemon's job across the boundary — it arms on our
// stdout/stderr), and agent stderr relays to ours. Returns the executor handle.
export function runHost(input: HostInput, deps: RunHostDeps): { kill: () => void } {
  const adapters =
    deps.adapters ?? buildAdapters({ root: ROOT, env: process.env })
  // A runtime instance purely for its identity minter and batch assembly — the
  // adapter, not a flow, drives the turn, so nothing here calls onTurn. Its
  // `emit` is where the normalized update comes out.
  const runtime = createCtxRuntime(input, {
    emit: deps.emit,
    now: deps.now,
    onStderr: deps.onStderr,
  })
  const bridge = createAdapterBridge(runtime.bridge)
  return runAgent(input, {
    // Session/turn-context/done pass straight through; only `update` is
    // re-minted, and only its ids change.
    emit: (event) => {
      if (event.kind === 'update') bridge.update(event)
      else deps.emit(event)
    },
    arm: () => {},
    onStderr: deps.onStderr,
    spawn: deps.spawn,
    mintSessionId: deps.mintSessionId ?? randomUUID,
    now: deps.now ?? (() => new Date().toISOString()),
    adapters,
  })
}

// Read stdin to end and parse the first non-empty line as the HostInput. The
// daemon writes exactly one line and ends the pipe; a trailing newline is harmless.
async function readInput(): Promise<HostInput> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const line = Buffer.concat(chunks)
    .toString('utf8')
    .split('\n')
    .find((l) => l.trim())
  if (!line) throw new Error('flow-host: no HostInput on stdin')
  return JSON.parse(line) as HostInput
}

async function main(): Promise<void> {
  const input = await readInput()
  const handle = runHost(input, {
    emit: emitLine,
    spawn: nodeSpawn,
    onStderr: (chunk) => process.stderr.write(chunk),
  })
  // A control signal from the daemon (interrupt / idle-kill / drain) or any exit
  // kills our agent child — belt-and-suspenders against orphans on top of the
  // daemon's process-group kill.
  const kill = () => handle.kill()
  process.on('SIGTERM', kill)
  process.on('SIGINT', kill)
  process.on('exit', kill)
  // The event loop drains once the agent child closes (its `done` already emitted),
  // so the host exits on its own — no explicit exit needed on the happy path.
}

// Run only when executed as the entry (spawned as `tsx daemon/flow-host.ts`), not
// when imported by a test.
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((e) => {
    emitLine({
      kind: 'done',
      exitCode: 1,
      stderr: `flow-host: ${e instanceof Error ? e.message : String(e)}`,
    })
    process.exit(1)
  })
}
