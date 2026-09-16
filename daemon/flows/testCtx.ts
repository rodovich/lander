// Transcript fixtures run through the real flow runtime with fake subprocesses.
// Each inner array of lines is one stdout chunk, preserving flush cadence.

import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { StartRunMessage } from '../../server/protocol'
import type { HostEvent, HostInput } from '../host-protocol'
import { createCtxRuntime, type Ctx, type TurnResult } from './ctx'

export class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill = (_signal?: string): boolean => {
    this.killed = true
    return true
  }
}

export type SpawnCapture = {
  command: string
  args: string[]
  cwd?: string
  // Only the vars the code under test ADDS — comparing whole environments would
  // drown the assert in the ambient process env.
  env: Record<string, string>
  envDelta: Record<string, string>
  child: FakeChild
}

// Capture launch arguments and environment independently of emitted events.
export function recordingSpawn(baseEnv: NodeJS.ProcessEnv = process.env) {
  const calls: SpawnCapture[] = []
  const spawn = (
    command: string,
    args: string[],
    options: SpawnOptions,
  ): ChildProcess => {
    const child = new FakeChild()
    const env = (options.env ?? {}) as Record<string, string>
    const envDelta: Record<string, string> = {}
    for (const [k, v] of Object.entries(env))
      if (baseEnv[k] !== v) envDelta[k] = v
    calls.push({
      command,
      args,
      cwd: options.cwd as string | undefined,
      env,
      envDelta,
      child,
    })
    return child as unknown as ChildProcess
  }
  return { calls, spawn }
}

// One golden transcript: what the agent child says, and the shape of the turn
// that produced it.
export type Golden = {
  name: string
  // Stdout as the child actually delivers it. At least one golden per provider
  // must carry a multi-line chunk, or the cadence assert proves nothing.
  chunks: string[][]
  exitCode?: number
  stderrChunks?: string[]
  start?: Partial<StartRunMessage>
  input?: Partial<HostInput>
}

export function goldenInput(g: Golden): HostInput {
  return {
    start: {
      type: 'start-run',
      runId: 'ride-1',
      taskId: 'task-1',
      agent: 'claude',
      project: 'proj',
      prompt: 'do the thing',
      task: { allowEdits: false },
      env: { LANDER_TASK: 'task-1', LANDER_PROJECT: 'proj' },
      idleTimeoutMs: 600_000,
      ...g.start,
    },
    root: '/repo',
    cwd: '/repo',
    ...g.input,
  }
}

// Keep transcript timestamps independent of the wall clock.
export const FIXED_NOW = '2026-01-01T00:00:00.000Z'

export type FlowDriveResult = {
  events: HostEvent[]
  spawns: SpawnCapture[]
  result: TurnResult
}

// Drive a flow's onTurn through the real runtime against a golden.
export async function driveFlow(
  g: Golden,
  flow: { onTurn(ctx: Ctx): Promise<TurnResult> },
): Promise<FlowDriveResult> {
  const events: HostEvent[] = []
  const { calls, spawn } = recordingSpawn()
  const runtime = createCtxRuntime(goldenInput(g), {
    emit: (e) => events.push(e),
    now: () => FIXED_NOW,
    spawn,
    onStderr: () => {},
  })

  let captured: TurnResult = { exitCode: 0 }
  const turn = runtime.runTurn({
    async onTurn(ctx) {
      captured = await flow.onTurn(ctx)
      return captured
    },
  })

  // Let the flow reach its spawn before feeding it anything.
  await settle()
  if (calls.length) await feed(calls[0].child, g)
  await turn
  return { events, spawns: calls, result: captured }
}

// Deliver the golden chunk-wise, then close. Yielding between chunks is what
// lets the consumer drain one chunk's lines and flush before the next arrives —
// i.e. it reproduces the real per-chunk cadence rather than dumping everything
// into one batch.
export async function feed(child: FakeChild, g: Golden): Promise<void> {
  for (const chunk of g.chunks) {
    child.stdout.emit(
      'data',
      Buffer.from(chunk.map((l) => `${l}\n`).join('')),
    )
    await settle()
  }
  for (const s of g.stderrChunks ?? []) {
    child.stderr.emit('data', Buffer.from(s))
    await settle()
  }
  child.stdout.emit('end')
  child.stderr.emit('end')
  child.emit('close', g.exitCode ?? 0)
  await settle()
}

// Flush the microtask queue *and* one macrotask turn, so an async generator
// awaiting new data has actually parked before the next chunk lands.
export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

// A concise turn fixture for driver argv/context tests. Execution still goes
// through the real runtime; this only translates fixture fields into HostInput.
export type DriverTurnFixture = {
  task: StartRunMessage['task'] & { sessionId?: string }
  prompt?: string
  root: string
  cwd: string
  effectiveCwd?: string
  recordedCwd?: string
  env?: Record<string, string>
  images?: string[]
  filesDir?: string
}

export async function captureDriverTurn(
  flow: Parameters<typeof driveFlow>[1],
  fixture: DriverTurnFixture,
) {
  const result = await driveFlow({
    name: 'driver turn',
    chunks: [],
    start: {
      task: fixture.task,
      recordedCwd: fixture.recordedCwd,
      sessionId: fixture.task.sessionId,
      prompt: fixture.prompt ?? 'go',
      env: fixture.env ?? {},
    },
    input: {
      root: fixture.root,
      cwd: fixture.cwd,
      effectiveCwd: fixture.effectiveCwd,
      filesDir: fixture.filesDir,
      materialized: fixture.images ? {
        images: fixture.images,
        filesDir: fixture.filesDir ?? '/files',
        manifestBlock: '',
      } : undefined,
    },
  }, flow)
  const context = result.events.flatMap((e) => e.kind === 'state-patch' ? e.ops : [])
    .find((op) => op.path.join('.') === 'turnContext')?.value
  return { ...result.spawns[0], context, events: result.events }
}
