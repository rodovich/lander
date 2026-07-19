// The flow host: one subprocess per run. It reads a HostInput as a single JSON
// line on stdin, drives the turn, and streams neutral HostEvents back as
// line-JSON on stdout. The agent grandchild's stdout never leaks here; its stderr
// is relayed to this process's stderr so the daemon's idle watchdog sees the
// activity through the boundary. On any exit it kills its children, so a killed
// host leaves no orphan.
//
// Two ways to drive a turn live here, and which one a provider gets is the
// cutover switch (LIVE_FLOWS in flows/index.ts):
//
//   - As a FLOW: construct ctx and call the flow module's onTurn. This is the
//     destination shape.
//   - As a compiled ADAPTER: runAgent, with its outgoing steps routed through
//     the ctx runtime's identity minter (the compatibility bridge) so the wire
//     looks the same either way.
//
// Both paths mint ids through the same runtime, which is what let the parity
// harness deep-equal whole task JSONs across them before any provider flipped.
//
// The daemon spawns one of these per run (daemon/run.ts). Because it lives under
// daemon/, daemon-watch reloads the daemon on edits to it.

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
import { buildFlows, type BundledFlow } from './flows/index'

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
  // Likewise for the ported flows. Anything in FLOW_MODULES runs its turn from
  // here.
  flows?: Partial<Record<string, BundledFlow>>
  // TEST SEAM ONLY. When set, selection is restricted to this set, which is the
  // only way to reach the compiled-adapter path below now that flow selection
  // isn't gated on a cutover set. adapter-bridge.test.ts passes an empty set to
  // exercise the bridge, which stays live until step 5 deletes the adapters.
  // Undefined in production: select whatever FLOW_MODULES holds.
  liveFlows?: ReadonlySet<AgentKind>
}

// Wire the turn to the host's seam: emit serializes to the daemon, `arm` is a
// no-op (idle activity is the daemon's job across the boundary — it arms on our
// stdout/stderr), and agent stderr relays to ours. Returns a kill handle covering
// whichever path drove the turn.
export function runHost(input: HostInput, deps: RunHostDeps): { kill: () => void } {
  const runtime = createCtxRuntime(input, {
    emit: deps.emit,
    now: deps.now,
    spawn: deps.spawn,
    onStderr: deps.onStderr,
  })

  // The flow to drive this turn. `flow ?? agent` so a start-run from a server
  // that predates the field still resolves.
  const name = input.start.flow ?? input.start.agent
  // Selection is by FLOW_MODULES membership (via buildFlows), NOT by a cutover
  // set — a gate keyed on a set of legacy providers could never admit a flow
  // that has no adapter. `deps.liveFlows`, when injected, restricts selection;
  // it is a TEST seam only (adapter-bridge.test.ts passes an empty set as the
  // only way to reach the adapter path below, which is still live until step 5).
  if (name && (deps.liveFlows?.has(name as AgentKind) ?? true)) {
    const flows = deps.flows ?? buildFlows({ root: ROOT, env: process.env })
    const flow = flows[name]
    if (flow) {
      // runTurn owns the done contract end to end: it awaits onTurn, SIGKILLs
      // anything the flow left running, flushes, and emits the done. Nothing is
      // awaited here — the host stays alive on its event loop until the turn
      // settles, exactly as it did under the adapter.
      void runtime.runTurn(flow)
      return { kill: () => runtime.killChildren() }
    }
  }

  // Compiled-adapter path. The runtime above is used only for its identity
  // minter and batch assembly here — the adapter drives the turn, so nothing
  // calls onTurn; its `emit` is where the normalized update comes out.
  const adapters =
    deps.adapters ?? buildAdapters({ root: ROOT, env: process.env })
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
  // kills whatever the turn left running — belt-and-suspenders against orphans on
  // top of the daemon's process-group kill. On the flow path this reaches every
  // ctx.spawn child rather than a single adapter child, which matters because a
  // flow can end while a child of its own is still alive.
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
