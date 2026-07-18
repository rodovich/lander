// The parity harness: for a golden transcript, prove the ported flow and the
// compiled adapter it replaces produce the same resulting task state and the same
// normalized wire sequence — so a cutover is behavior-neutral rather than
// hopefully-equivalent.
//
// Both sides emit HostEvents over the same seam, so both go through one
// mini-supervisor that does what daemon/run.ts does (assign seq, map events to
// protocol messages) and then fold onto a fresh Task with the REAL server
// consumers — applyUpdate / applyDone / applyStatePatch / the thread-state
// accessors, not stand-ins. What is compared is therefore what the user would
// actually see.
//
// The oracle runs through the ctx runtime's identity minter too (the adapter
// bridge), which is what makes the comparison a literal deep-equal instead of a
// hand-written id normalization — and is why that bridge landed before any
// cutover rather than alongside one.

import type { AgentAdapter } from '../agent'
import type { StartRunMessage } from '../../server/protocol'
import type { HostEvent, HostInput } from '../run-agent'
import { runAgent } from '../run-agent'
import { createCtxRuntime } from './ctx'
import { createAdapterBridge } from './adapter-bridge'
import {
  applyDone,
  applyUpdate,
  type ApplyTask,
} from '../../server/apply'
import { applyStatePatch } from '../../server/flowstate'
import {
  setTaskSessionId,
  setTaskTurnContext,
  startRide,
  taskSessionId,
} from '../../server/tasks'
import {
  FIXED_NOW,
  feed,
  goldenInput,
  recordingSpawn,
  settle,
  type Golden,
  type SpawnCapture,
} from './testCtx'

export type PathResult = {
  events: HostEvent[]
  spawns: SpawnCapture[]
  task: Record<string, unknown>
}

// Drive the compiled adapter (the oracle) against a golden.
export async function driveAdapter(
  g: Golden,
  adapters: Partial<Record<string, AgentAdapter>>,
  mint: () => string,
): Promise<PathResult> {
  const input = goldenInput(g)
  const events: HostEvent[] = []
  const { calls, spawn } = recordingSpawn()

  // The oracle's steps go through the same runtime minter the flow uses, so the
  // ids on both sides come from one encounter-order counter.
  const runtime = createCtxRuntime(input, {
    emit: (e) => events.push(e),
    now: () => FIXED_NOW,
    onStderr: () => {},
  })
  const bridge = createAdapterBridge(runtime.bridge)

  runAgent(input, {
    emit: (e) => {
      if (e.kind === 'update') bridge.update(e)
      else events.push(e)
    },
    arm: () => {},
    spawn,
    mintSessionId: mint,
    now: () => FIXED_NOW,
    adapters: adapters as never,
  })

  await settle()
  if (calls.length) await feed(calls[0].child, g)
  await settle()

  return { events, spawns: calls, task: applyEvents(input.start, events) }
}

// The mini-supervisor + server fold. Deliberately mirrors run.ts's event routing
// and reduceRunWs's handling — including the set-once session guard, which is
// what a real turn's session announcement passes through.
export function applyEvents(
  start: StartRunMessage,
  events: HostEvent[],
): Record<string, unknown> {
  const task = freshTask(start)
  let seq = 0
  let rateLimitResetsAt: string | undefined

  for (const event of events) {
    switch (event.kind) {
      case 'session':
        // reduceRunWs's `if (!taskSessionId(t))` — a replayed announcement finds
        // it already set.
        if (!taskSessionId(task as never))
          setTaskSessionId(task as never, event.sessionId)
        break
      case 'turn-context':
        setTaskTurnContext(task as never, event.context)
        break
      case 'state-patch':
        applyStatePatch(task as never, event.ops, event.rev)
        break
      case 'update':
        if (event.rateLimitResetsAt) rateLimitResetsAt = event.rateLimitResetsAt
        applyUpdate(task as unknown as ApplyTask, {
          steps: event.steps,
          finalText: event.finalText,
          blockedIds: event.blockedIds,
          usage: event.usage,
          usageChanged: event.usageChanged,
          drivingModel: event.drivingModel,
          cursor: ++seq,
        })
        break
      case 'done':
        applyDone(
          task as unknown as ApplyTask,
          { exitCode: event.exitCode, interrupted: false, stderr: event.stderr },
          {
            at: FIXED_NOW,
            askId: 'ask-1',
            ...(rateLimitResetsAt ? { rateLimitResetsAt } : {}),
          },
        )
        break
    }
  }
  return task
}

function freshTask(start: StartRunMessage): Record<string, unknown> {
  const task: Record<string, unknown> = {
    id: start.taskId,
    title: 'Parity task',
    status: 'riding',
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
    allowEdits: start.task.allowEdits,
    shape: 2,
    items: [],
    rides: [],
    ...(start.flowState ? { flowState: { ...start.flowState } } : {}),
    ...(start.flowStateRev !== undefined
      ? { flowStateRev: start.flowStateRev }
      : {}),
    ...(start.sessionId ? { sessionId: start.sessionId } : {}),
    ...(start.turnContext ? { turnContext: start.turnContext } : {}),
  }
  startRide(task as never, start.runId, FIXED_NOW)
  return task
}

// applyStatePatch stamps flowStateRev on the flow path while the oracle's
// accessor writes never do. It is a dedupe counter, not state — the single named
// exception to "no normalization" in this compare.
export function forCompare(task: Record<string, unknown>): Record<string, unknown> {
  const { flowStateRev: _drop, ...rest } = task
  return rest
}
