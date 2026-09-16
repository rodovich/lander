// One subprocess per turn: read HostInput, run a flow, emit HostEvents.

import { spawn as nodeSpawn } from 'node:child_process'
import { ROOT } from './paths'
import { isEntry, readInputLine } from './processes'
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

// The supervisor watches stdout/stderr for idle activity across this boundary.
export function runHost(input: HostInput, deps: RunHostDeps): { kill: () => void } {
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
    return { kill: () => {} }
  }
  // runTurn owns child cleanup, state flushing, and the terminal event.
  void runtime.runTurn(flow)
  return { kill: () => runtime.killChildren() }
}

async function main(): Promise<void> {
  const input = await readInputLine<HostInput>('flow-host')
  const handle = runHost(input, {
    emit: emitLine,
    spawn: nodeSpawn,
    onStderr: (chunk) => process.stderr.write(chunk),
  })
  // The daemon stops a host only by SIGKILLing its process group, which takes
  // every ctx.spawn child with it. This covers the host exiting on its own with
  // a turn still running.
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
