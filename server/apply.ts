// The pure task-mutation consumer: how a run-update mutates a task, decoupled
// from where updates come from (a tailed file today, a WebSocket later).
// reduceRun in index.ts produces the resolved
// update/done payloads from the byte stream and hands them here; these functions
// fold them onto the task and nothing else. They do no I/O and have no
// side-effects beyond mutating the passed task in place — in particular they do
// NOT refresh usage (that trigger stays in the caller). Kept import-light (tasks
// + stream + protocol types only) so neither side of the split depends on
// index.ts.
//
// Storage is the v2 item log (rides + items). The daemon still sends the frozen
// wire shape (Step[] deltas); these functions translate steps → items at apply
// time — a tool_use step becomes a running tool item, its tool_result folds onto
// that item by id, and a text step becomes a flow message item. The fold-by-id
// keys on the provider toolUseId, which is exactly the id the migrate converter
// mints too, so a turn that streamed half its steps under v1 and half under v2
// reconciles seamlessly.

import type { Step, Usage } from './stream'
import type { UpdateMessage, DoneMessage } from './protocol'
import {
  openRide,
  closeRide,
  pushFlowItem,
  lastFlowItem,
  nextItemId,
  recordStatusTransition,
  lastTurnPrompts,
  type Item,
  type ToolItem,
  type Ride,
} from './tasks'
import { createRetryAsk, type Ask } from './asks'

// The slice of a task these functions read and write. index.ts's full Task
// satisfies this structurally, so it can pass its own value without conversion;
// typing it structurally also lets the functions be unit-tested against minimal
// fixtures.
export type ApplyTask = {
  status: string
  title: string
  items?: Item[]
  rides?: Ride[]
  asks?: Ask[]
  updatedAt: string
  runId?: string
  runCursor?: number
  retry?: { committed: boolean; prompts: string[]; resetsAt?: string }
}

// One reduced batch of run output to fold onto the task: the activity it
// contributes plus the accumulated reply text / blocked-call ids / usage. Mirrors
// the wire `UpdateMessage` (steps/finalText/blockedIds/usage/drivingModel), but
// carries the resolved `usage` (the liveUsage to store) and the `usageChanged`
// flag the caller computed, plus the byte `cursor` to persist — the seq vs. byte
// distinction stays the caller's, this just stores whatever it's given.
export type ApplyUpdate = Pick<
  UpdateMessage,
  'steps' | 'finalText' | 'blockedIds' | 'drivingModel'
> & {
  // The resolved running usage to set on the ride (the caller's accumulated
  // `liveUsage`), applied only when `usageChanged`.
  usage?: Usage
  usageChanged: boolean
  // The value to persist as the task's run cursor. A byte offset today; the
  // caller owns what it means.
  cursor: number
}

// The run's terminal signal: the agent process exit code, whether the stop was a
// deliberate interrupt, and any captured stderr. Mirrors the wire `DoneMessage`
// but leaves `interrupted`/`stderr` optional, since today's file producer reads
// them from a done.json that may omit either (the inline code treated both as
// optional); the WS `DoneMessage` always sends them, which still satisfies this.
// `cause`/`idleMs` ride along from a daemon-synthesized done (idle kill, daemon
// shutdown, host crash) so the wedge can name the failure.
export type ApplyDone = Pick<DoneMessage, 'exitCode'> &
  Partial<Pick<DoneMessage, 'interrupted' | 'stderr' | 'cause' | 'idleMs'>>

// Side inputs applyDone needs that don't come off the done payload itself: the
// rate-limit reset time captured during the run (carried onto a wedge's retry),
// the timestamp to stamp the finish with, and the id to mint the platform retry
// ask under when the run wedges (supplied by the caller so applyDone stays pure
// and injection-friendly).
export type ApplyDoneOpts = {
  rateLimitResetsAt?: string
  at: string
  askId: string
}

// The tool_result outcome → the folded tool item status.
function resultStatus(step: Step): ToolItem['status'] {
  return step.blocked ? 'blocked' : step.isError ? 'failed' : 'ok'
}

// Wedge a task for a retry and stash what recovery needs: flip to wedged, record
// whether the failed turn committed (so recovery nudges vs. re-sends), its
// prompts, and any rate-limit reset, then raise the origin:'retry' platform ask
// that routes the answer back through applyRetryRecovery. The single place the
// wedge + stash + retry-ask trio is assembled, so applyDone (assistant error),
// the daemon-outage wedge, and the platform-kill (crashed) wedge stay identical
// bar the ask's `prompt`, which names the cause. Callers own the "still riding"
// precondition and any transcript/error line — this only mutates status/retry/ask.
export function wedgeForRetry(
  task: ApplyTask,
  opts: {
    committed: boolean
    askId: string
    at: string
    resetsAt?: string
    prompt?: string
  },
): void {
  recordStatusTransition(task, 'wedged', opts.at)
  task.status = 'wedged'
  task.retry = {
    committed: opts.committed,
    prompts: lastTurnPrompts(task),
    ...(opts.resetsAt ? { resetsAt: opts.resetsAt } : {}),
  }
  createRetryAsk(task, {
    id: opts.askId,
    committed: opts.committed,
    ...(opts.resetsAt ? { resetsAt: opts.resetsAt } : {}),
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    at: opts.at,
  })
}

// Apply one reduced batch onto the task: fold its steps into the open ride's item
// log, reconcile blocked tool calls, carry the running reply text and usage,
// advance the run cursor. Mutates the task in place.
export function applyUpdate(task: ApplyTask, update: ApplyUpdate): void {
  const { steps, finalText, blockedIds, usage, usageChanged, drivingModel, cursor } =
    update
  if (
    steps.length ||
    finalText !== undefined ||
    (blockedIds?.length ?? 0) ||
    usageChanged
  ) {
    const ride = openRide(task)
    // A run always opens a ride before it streams (runTurn), and a run that began
    // under v1 is converted to an open ride keyed by its runId — so a batch should
    // always find one. Guard defensively rather than throw.
    if (ride) {
      const rideId = ride.id
      const items = (task.items ??= [])
      // Bump updatedAt only on the batch that begins the ride's activity (adds its
      // first item), not on every streamed batch — streaming churn shouldn't keep
      // reordering the sidebar (the old "begun" rule).
      const begun = !items.some((it) => it.rideId === rideId)
      let firstAt: string | undefined
      const toolItem = (id: string) =>
        items.find(
          (it): it is ToolItem =>
            it.kind === 'tool' && it.rideId === rideId && it.id === id,
        )
      for (const s of steps) {
        if (s.kind === 'tool_use') {
          items.push({
            id: s.toolUseId ?? nextItemId(task, s.createdAt),
            at: s.createdAt,
            rideId,
            kind: 'tool',
            name: s.tool ?? '',
            input: s.input ?? '',
            status: 'running',
            ...(s.inputFull ? { inputFull: s.inputFull } : {}),
            ...(s.rule ? { rule: s.rule } : {}),
            ...(s.edits ? { edits: s.edits } : {}),
            ...(s.inferenceId ? { groupId: s.inferenceId } : {}),
            ...(s.parentToolUseId ? { parentId: s.parentToolUseId } : {}),
          })
          firstAt ??= s.createdAt
        } else if (s.kind === 'tool_result') {
          const target = s.toolUseId ? toolItem(s.toolUseId) : undefined
          if (target) {
            if (s.text !== undefined) target.output = s.text
            target.status = resultStatus(s)
          } else {
            // Orphan result — keep it as a standalone tool item rather than dropping.
            items.push({
              id: s.toolUseId ?? nextItemId(task, s.createdAt),
              at: s.createdAt,
              rideId,
              kind: 'tool',
              name: '',
              input: '',
              status: resultStatus(s),
              ...(s.text !== undefined ? { output: s.text } : {}),
              ...(s.parentToolUseId ? { parentId: s.parentToolUseId } : {}),
            })
            firstAt ??= s.createdAt
          }
        } else {
          // text step → flow message item (a subagent's prose nests via parentId).
          items.push({
            id: nextItemId(task, s.createdAt),
            at: s.createdAt,
            rideId,
            kind: 'message',
            role: 'flow',
            text: s.text ?? '',
            ...(s.inferenceId ? { groupId: s.inferenceId } : {}),
            ...(s.parentToolUseId ? { parentId: s.parentToolUseId } : {}),
          })
          firstAt ??= s.createdAt
        }
      }
      // The terminal result event names the refused tool calls; flag those tool
      // items blocked. The result lands after the steps streamed (often an earlier
      // batch), so reconcile across the whole ride, not just this batch.
      if (blockedIds?.length) {
        const denied = new Set(blockedIds)
        for (const it of items)
          if (it.kind === 'tool' && it.rideId === rideId && denied.has(it.id))
            it.status = 'blocked'
      }
      // Carry the running reply text: update the ride's last main-agent flow item
      // in place (for a live turn finalText mirrors the last text step, so this is
      // the same text), creating one only if the turn streamed no prose at all.
      if (finalText !== undefined) {
        const last = lastFlowItem(task, rideId)
        if (last) last.text = finalText
        else {
          const at = firstAt ?? ride.startedAt
          pushFlowItem(task, rideId, finalText, at)
          firstAt ??= at
        }
      }
      // Record the turn's running usage on the ride, stamped with the session's
      // driving model (not a tool-heavy subagent's cheaper model).
      if (usageChanged && usage)
        ride.usage = drivingModel ? { ...usage, model: drivingModel } : usage
      if (begun) task.updatedAt = firstAt ?? ride.startedAt
    }
  }
  task.runCursor = cursor
}

// Finalize the run on its done marker: close the ride, write the error/interrupted
// text when nothing streamed, and on a real assistant error wedge the task and
// stash what a retry needs. Mutates the task in place. Does NOT refresh usage.
export function applyDone(
  task: ApplyTask,
  done: ApplyDone,
  opts: ApplyDoneOpts,
): void {
  const { at, rateLimitResetsAt, askId } = opts
  const ride = openRide(task)
  const rideId = ride?.id
  // The ride's own items, snapshotted before we append any error line below.
  const rideItems = rideId
    ? (task.items ?? []).filter((it) => it.rideId === rideId)
    : []
  const streamedText = rideItems.some(
    (it) => it.kind === 'message' && it.text.trim().length > 0,
  )
  // Whether the assistant had begun replying before the run ended (streamed a tool
  // or non-empty reply). On an assistant error this is our proxy for "the user's
  // turn reached the session and was committed".
  const hadOutput = rideItems.some((it) => it.kind === 'tool') || streamedText
  // A non-zero exit with no reply is an error to surface; a deliberate interrupt
  // (the task was wedged mid-run) is not — note the stop only if nothing streamed.
  if (rideId && !streamedText) {
    if (done.interrupted) pushFlowItem(task, rideId, '_(interrupted)_', at)
    else if (done.exitCode !== 0)
      pushFlowItem(
        task,
        rideId,
        `error running assistant: exited ${done.exitCode}` +
          (done.stderr?.trim() ? `\n${done.stderr.trim()}` : ''),
        at,
      )
  }
  // An assistant error — a non-zero exit that isn't a deliberate interrupt — needs
  // the user's attention, so wedge the task with the platform retry ask (usage-limit
  // or generic error). Only override a still-riding task: a self-wedge/land the
  // agent set stands. Name the failure when we can — the daemon's synthesized-done
  // cause, or the first stderr line of a natural non-zero exit; a usage-limit
  // wedge keeps its reset-time wording.
  if (done.exitCode !== 0 && !done.interrupted && task.status === 'riding') {
    const prompt = rateLimitResetsAt ? undefined : failurePrompt(done)
    wedgeForRetry(task, {
      committed: hadOutput,
      askId,
      at,
      ...(rateLimitResetsAt ? { resetsAt: rateLimitResetsAt } : {}),
      ...(prompt ? { prompt } : {}),
    })
  }
  // Close the ride: interrupted on a deliberate stop, error on a non-zero
  // non-interrupt exit, else done. Usage already rides on it (applyUpdate). A run
  // started before rides existed has none — closeRide no-ops.
  const outcome: Ride['outcome'] = done.interrupted
    ? 'interrupted'
    : done.exitCode !== 0
      ? 'error'
      : 'done'
  // Stash the failure's diagnostics on the ride before it closes: exit code, the
  // daemon's cause, and the stderr tail. The retry ask is answered and gone once
  // the user retries — this is the record that outlives it.
  if (outcome === 'error' && ride) {
    const stderrTail = done.stderr?.trim().slice(-2000)
    ride.error = {
      exitCode: done.exitCode,
      ...(done.cause ? { cause: done.cause } : {}),
      ...(done.idleMs ? { idleMs: done.idleMs } : {}),
      ...(stderrTail ? { stderr: stderrTail } : {}),
    }
  }
  closeRide(task, outcome, at)
  task.updatedAt = at
  delete task.runId
  delete task.runCursor
}

// The one-line cause for a failed run's retry ask. A daemon-synthesized done
// names why the daemon ended the run (the idle watchdog with its window, a
// daemon shutdown, a host crash); a natural non-zero exit surfaces its first
// stderr line. Undefined when there's nothing to say — createRetryAsk then
// falls back to its generic "The assistant run failed."
function failurePrompt(done: ApplyDone): string | undefined {
  if (done.cause === 'idle-timeout') {
    const mins = done.idleMs ? Math.round(done.idleMs / 60_000) : 0
    return mins
      ? `The assistant went silent for ${mins} minute${mins === 1 ? '' : 's'} and was stopped.`
      : 'The assistant went silent and was stopped.'
  }
  if (done.cause === 'daemon-shutdown')
    return 'The daemon shut down and stopped the run.'
  if (done.cause === 'host-crash')
    return 'The assistant process died without reporting a result.'
  const first = done.stderr
    ?.split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  if (!first) return undefined
  return `The assistant run failed: ${first.length > 120 ? `${first.slice(0, 119)}…` : first}`
}
