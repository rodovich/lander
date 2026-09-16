// One subprocess per turn: read HostInput, run a flow, emit HostEvents.

import { spawn as nodeSpawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ROOT } from './paths'
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
  // The daemon stops a host only by SIGKILLing its process group, which takes
  // every ctx.spawn child with it. This covers the host exiting on its own with
  // a turn still running.
  process.on('exit', () => handle.kill())
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
