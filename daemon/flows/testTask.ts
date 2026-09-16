// Fold flow output through the server reducers for transcript regression tests.
import type { StartRunMessage } from '../../server/protocol'
import type { HostEvent } from '../host-protocol'
import { applyDone, applyUpdate, type ApplyTask } from '../../server/apply'
import { applyStatePatch } from '../../server/flowstate'
import {
  setTaskSessionId,
  setTaskTurnContext,
  startRide,
  taskSessionId,
} from '../../server/tasks'
import { FIXED_NOW } from './testCtx'

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
