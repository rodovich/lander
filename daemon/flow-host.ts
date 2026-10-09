// One subprocess per turn: read HostInput, run a flow, emit HostEvents.

import { spawn as nodeSpawn } from 'node:child_process'
import { ROOT } from './paths'
import { HOST_STOP_GRACE_MS, isEntry, readInputLine } from './processes'
import type { HostEvent, HostInput, SpawnLike } from './host-protocol'
import { createCtxRuntime } from './flows/ctx'
import { buildFlows, type BundledFlow } from './flows/index'

// Serialize one neutral event as a JSON line on stdout — the host → daemon wire.
export function emitLine(event: HostEvent): void {
  process.stdout.write(JSON.stringify(event) + '\n')
}

export type RunHostDeps = {
  emit: (event: HostEvent) => void
  spawn?: SpawnLike
  now?: () => string
  onStderr?: (chunk: string) => void
  flows?: Partial<Record<string, BundledFlow>>
}

export type HostHandle = {
  kill: () => void
  terminate: (graceMs: number) => Promise<void>
}

// The supervisor watches stdout/stderr for idle activity across this boundary.
export function runHost(input: HostInput, deps: RunHostDeps): HostHandle {
  const runtime = createCtxRuntime(input, {
    emit: deps.emit,
    now: deps.now,
    spawn: deps.spawn,
    onStderr: deps.onStderr,
  })

  const name = input.start.flow ?? input.start.agent
  const flows = deps.flows ?? buildFlows({ root: ROOT, env: process.env })
  const flow = name ? flows[name] : undefined
  if (!flow) {
    deps.emit({
      kind: 'done',
      exitCode: 1,
      stderr: `unsupported flow: ${name ?? '(none)'}`,
    })
    return { kill: () => {}, terminate: async () => {} }
  }
  // runTurn owns child cleanup, state flushing, and the terminal event.
  void runtime.runTurn(flow)
  return {
    kill: () => runtime.killChildren(),
    terminate: (graceMs) => runtime.terminateChildren(graceMs),
  }
}

async function main(): Promise<void> {
  const input = await readInputLine<HostInput>('flow-host')
  const handle = runHost(input, {
    emit: emitLine,
    spawn: nodeSpawn,
    onStderr: (chunk) => process.stderr.write(chunk),
  })
  // The daemon stops a host with SIGTERM, and SIGKILLs its process group if it
  // is still alive later. On SIGTERM the host passes the signal on to its
  // children and lets the turn end as their exit ends it, so an agent can stop
  // work of its own that the group kill can't reach, and the flow still flushes
  // its state.
  process.on('SIGTERM', () => {
    void handle.terminate(HOST_STOP_GRACE_MS)
  })
  // Covers the host exiting on its own with a turn still running.
  process.on('exit', () => handle.kill())
  // The event loop drains once the agent child closes (its `done` already emitted),
  // so the host exits on its own — no explicit exit needed on the happy path.
}

// Run only when executed as the entry, not when imported by a test.
if (isEntry(import.meta.url)) {
  main().catch((e) => {
    emitLine({
      kind: 'done',
      exitCode: 1,
      stderr: `flow-host: ${e instanceof Error ? e.message : String(e)}`,
    })
    process.exit(1)
  })
}
