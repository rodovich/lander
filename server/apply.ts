// The pure task-mutation consumer: how a run-update mutates a task, decoupled
// from where updates come from (a tailed file today, a WebSocket later).
// reduceRun in index.ts produces the resolved
// update/done payloads from the byte stream and hands them here; these functions
// fold them onto the task and nothing else. They do no I/O and have no
// side-effects beyond mutating the passed task in place — in particular they do
// NOT refresh usage (that trigger stays in the caller). Kept import-light (tasks
// + stream + protocol types only) so neither side of the split depends on
// index.ts.

import type { Step, Usage } from './stream'
import type { UpdateMessage, DoneMessage } from './protocol'
import {
  ensurePending,
  pendingMessage,
  recordStatusTransition,
  lastTurnPrompts,
  type Message,
  type TaskEvent,
} from './tasks'
import { createRetryAsk, type Ask } from './asks'

// The slice of a task these functions read and write. index.ts's full Task
// satisfies this structurally, so it can pass its own value without conversion;
// typing it structurally also lets the functions be unit-tested against minimal
// fixtures.
export type ApplyTask = {
  status: string
  title: string
  messages: Message[]
  events?: TaskEvent[]
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
  // The resolved running usage to set on the message (the caller's accumulated
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
export type ApplyDone = Pick<DoneMessage, 'exitCode'> &
  Partial<Pick<DoneMessage, 'interrupted' | 'stderr'>>

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

// Apply one reduced batch onto the task: append its steps, reconcile blocked
// tool_result steps, carry the running reply text and usage, advance the run
// cursor. Mutates the task in place. Behavior-identical to the per-batch UPDATE
// apply that lived inline in reduceRun.
export function applyUpdate(task: ApplyTask, update: ApplyUpdate): void {
  const { steps, finalText, blockedIds, usage, usageChanged, drivingModel, cursor } =
    update
  if (
    steps.length ||
    finalText !== undefined ||
    (blockedIds?.length ?? 0) ||
    usageChanged
  ) {
    // Bump updatedAt only on the batch that begins the assistant message
    // (creates the pending one), not on every streamed batch: streaming
    // churn shouldn't keep reordering the sidebar.
    const begun = !pendingMessage(task)
    const msg = ensurePending(task)
    if (steps.length) msg.steps = [...(msg.steps ?? []), ...steps]
    // The turn's terminal result event names the tool calls that were
    // refused; flag their tool_result steps blocked. The result lands
    // after those steps streamed (often in an earlier batch), so reconcile
    // across the whole message, not just this batch.
    if (blockedIds?.length && msg.steps) {
      const denied = new Set(blockedIds)
      for (const s of msg.steps)
        if (s.kind === 'tool_result' && s.toolUseId && denied.has(s.toolUseId))
          s.blocked = true
    }
    // Carry the running reply text onto the message as it lands so it
    // survives a restart (the cursor won't replay it).
    if (finalText !== undefined) msg.text = finalText
    // Record the turn's running token usage as it streams (summed across
    // inferences, finalized by the result event) so the UI's corner
    // readout updates live, not just at turn end. Always attribute it to
    // the session's driving model — not the per-inference or dominant
    // model, which a tool-heavy subagent on a cheaper model would skew.
    if (usageChanged && usage)
      msg.usage = drivingModel ? { ...usage, model: drivingModel } : usage
    if (begun) task.updatedAt = msg.createdAt
  }
  task.runCursor = cursor
}

// Finalize the run on its done marker: land the pending message, write the
// error/interrupted text, and on a real assistant error wedge the task and stash
// what a retry needs. Mutates the task in place. Does NOT refresh usage — that
// side-effect stays in the caller. Behavior-identical to the DONE apply that
// lived inline in reduceRun.
export function applyDone(
  task: ApplyTask,
  done: ApplyDone,
  opts: ApplyDoneOpts,
): void {
  const { at, rateLimitResetsAt, askId } = opts
  const msg = ensurePending(task)
  // Whether the assistant had begun replying before the run ended: real streamed
  // content (steps or text) on the pending message, captured before we
  // overwrite an empty one with the error below. On an assistant error this is
  // our proxy for "the user's turn reached the session and was committed" — if
  // a reply had started, the agent had accepted and recorded the prompt.
  const hadOutput = (msg.steps?.length ?? 0) > 0 || msg.text.trim().length > 0
  // A non-zero exit with no reply text is an error to surface; otherwise
  // the reduced text stands as the reply. A deliberate interrupt (the task
  // was wedged mid-run) is not an error — keep the partial reply, and note
  // the stop if nothing had streamed yet.
  if (!msg.text && done.interrupted) msg.text = '_(interrupted)_'
  else if (!msg.text && done.exitCode !== 0)
    msg.text =
      `error running assistant: exited ${done.exitCode}` +
      (done.stderr?.trim() ? `\n${done.stderr.trim()}` : '')
  msg.pending = false
  // An assistant error — a non-zero exit that isn't a deliberate interrupt,
  // most often an error HTTP response from the assistant — needs the
  // user's attention, so wedge the task rather than letting driveTask
  // quietly bring it to rest. We only override a still-riding task: if the
  // agent already moved itself (its own `lander wedge`, or `lander land`),
  // that stands. driveTask's finally only demotes riding→resting, so a
  // wedge set here survives it.
  if (done.exitCode !== 0 && !done.interrupted && task.status === 'riding') {
    recordStatusTransition(task, 'wedged', at)
    task.status = 'wedged'
    // Stash what a retry needs: whether the failed turn was committed, and
    // its prompt(s) for the re-send path. The error reply is now the
    // trailing message, so the prompt(s) sit just before it. A session-limit
    // rejection also carries its reset time, so the retry can be scheduled
    // for then rather than fired into the same wall.
    task.retry = {
      committed: hadOutput,
      prompts: lastTurnPrompts(task.messages),
      ...(rateLimitResetsAt ? { resetsAt: rateLimitResetsAt } : {}),
    }
    // Raise the platform ask the UI renders over the wedge: a usage-limit ask
    // (with a schedule-at-reset option) when the run carried a reset time, else
    // a generic error ask. origin:'retry' routes the answer back through the
    // retry-recovery machinery, which reads the `retry` stash above.
    createRetryAsk(task, {
      id: askId,
      committed: hadOutput,
      resetsAt: rateLimitResetsAt,
      at,
    })
  }
  task.updatedAt = at
  delete task.runId
  delete task.runCursor
}
