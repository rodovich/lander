// The Ask primitive: a stored question (a choice of options) the platform or a
// task raises, and the pure helpers that create, answer, and withdraw them. Asks
// are stored as `ask` items in the unified item log (task.items); the `Ask` type
// below stays the *wire* shape publicTask projects them back to. These helpers
// operate on the ask items directly and are kept pure/structurally typed (like
// tasks.ts) so they unit-test without the server: the endpoints in index.ts own
// the wedge/queue/schedule side-effects, these own the ask shape and routing.

import type { AskItem, Item } from './tasks'

// One option in a `choice` form. `at` (only meaningful on a choice option) makes
// answering schedule the delivery for that time via the task's `scheduledFor`
// machinery (e.g. "retry when the limit resets"); `value` + `editable` prefill a
// text the user can amend before answering (e.g. a permission rule).
export type AskOption = {
  id: string
  label: string
  detail?: string
  style?: 'primary' | 'danger'
  at?: string
  value?: string
  editable?: boolean
}

// Only the choice form ships: wedge, ask, and the platform retry ask all raise a
// choice of options. A confirm form (a degenerate two-option choice) and a
// free-text form (it would just duplicate the composer) were dropped as
// producerless. Kept a discriminated shape so a future variant is a non-breaking
// addition and stored asks keep their `type` tag.
export type AskForm = { type: 'choice'; options: AskOption[] }

export type Ask = {
  // ask-<epoch36>-<seq>, minted by the caller of createAsk from the current
  // clock and the task's existing ask count.
  id: string
  createdAt: string
  // Optional markdown shown above the form. An agent-raised wedge omits it — the
  // agent's own message is the question, and the form renders under that message
  // — so only platform asks (e.g. the retry ask) carry their own prompt.
  prompt?: string
  form: AskForm
  // Task-blocking is the only behavior implemented; `ride`/`none` ship in the
  // vocabulary but the create endpoint rejects them (see conversation-model.md).
  blocking: 'ride' | 'task' | 'none'
  state: 'open' | 'answered' | 'withdrawn'
  answer?: { optionId?: string; text?: string; at: string }
  // Marks the platform-emitted usage-limit/error ask so the answer endpoint
  // routes it through the retry-recovery machinery instead of delivering a
  // generic answer message (see the recast in apply.ts / index.ts).
  origin?: 'retry'
}

// The platform retry ask's option ids: retry immediately, or (usage-limit only)
// schedule the retry for when the limit resets. The answer endpoint routes an
// origin:'retry' ask through applyRetryRecovery keyed on which was chosen.
export const RETRY_NOW = 'retry-now'
export const RETRY_AT_RESET = 'retry-at-reset'

// The task slice the ask helpers read and write: the unified item log, in which
// asks live as `ask` items. index.ts's Task satisfies this structurally.
export type AskTask = { items?: Item[] }

// The ask items on a task, in order (the v2 analog of the old `task.asks`).
export function askItems(task: AskTask): AskItem[] {
  return (task.items ?? []).filter((it): it is AskItem => it.kind === 'ask')
}

// Validate a form's shape for the create endpoint. Returns an error string (for
// a 400) or null when well-formed. Guards exactly what the renderer/answer path
// assumes: a choice needs at least one option, each with a non-empty id + label
// and unique ids.
export function validateAskForm(form: unknown): string | null {
  if (!form || typeof form !== 'object') return 'form is required'
  if ((form as { type?: unknown }).type !== 'choice')
    return 'form.type must be choice'
  const opts = (form as { options?: unknown }).options
  if (!Array.isArray(opts) || opts.length === 0)
    return 'a choice form needs at least one option'
  const ids = new Set<string>()
  for (const o of opts) {
    if (!o || typeof o !== 'object') return 'each option must be an object'
    const opt = o as { id?: unknown; label?: unknown }
    if (typeof opt.id !== 'string' || !opt.id.trim())
      return 'each option needs an id'
    if (typeof opt.label !== 'string' || !opt.label.trim())
      return 'each option needs a label'
    if (ids.has(opt.id)) return `duplicate option id: ${opt.id}`
    ids.add(opt.id)
  }
  return null
}

// Mint the id for the next ask on a task: `ask-<epoch36>-<seq>`, where seq is the
// task's current ask count (so ids stay stable and ordered within a task).
export function nextAskId(task: AskTask, nowMs: number): string {
  return `ask-${Math.floor(nowMs).toString(36)}-${askItems(task).length}`
}

// Build an open ask item and append it to the task's item log, returning it.
// Assumes the form has already passed validateAskForm (the create endpoint checks
// and 400s first; createAsk is the plumbing that stamps state and pushes).
// `origin` marks a platform retry ask; `parentId` anchors an agent-raised ask to
// the message that raised it (the form renders as that message's footer).
export function createAsk(
  task: AskTask,
  opts: {
    id: string
    prompt?: string
    form: AskForm
    blocking: Ask['blocking']
    origin?: 'retry'
    parentId?: string
    at: string
  },
): AskItem {
  const ask: AskItem = {
    id: opts.id,
    at: opts.at,
    kind: 'ask',
    form: opts.form,
    blocking: opts.blocking,
    state: 'open',
    ...(opts.prompt ? { prompt: opts.prompt } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
  }
  ;(task.items ??= []).push(ask)
  return ask
}

// Build the platform ask a wedge raises alongside its retry stash (origin:
// 'retry', task-blocking). A usage-limit wedge (resetsAt present) offers two
// options — retry now, or retry when the limit resets (carrying `at` so
// answering schedules the wakeup); a generic error offers one, labelled by
// whether the failed turn committed ("Try again" vs "Resend"). The single place
// the retry ask's shape is defined, so applyDone and the daemon-outage wedge
// agree. `id`/`at` are the caller's (kept injection-friendly for pure tests).
export function createRetryAsk(
  task: AskTask,
  opts: { id: string; committed: boolean; resetsAt?: string; at: string },
): AskItem {
  const form: AskForm = opts.resetsAt
    ? {
        type: 'choice',
        options: [
          { id: RETRY_NOW, label: 'Retry now' },
          {
            id: RETRY_AT_RESET,
            label: 'Retry when the limit resets',
            at: opts.resetsAt,
            style: 'primary',
          },
        ],
      }
    : {
        type: 'choice',
        options: [{ id: RETRY_NOW, label: opts.committed ? 'Try again' : 'Resend' }],
      }
  return createAsk(task, {
    id: opts.id,
    prompt: opts.resetsAt ? 'Usage limit reached.' : 'The assistant run failed.',
    form,
    blocking: 'task',
    origin: 'retry',
    at: opts.at,
  })
}

// Project an ask item back to the `Ask` wire shape (`createdAt` from the item's
// `at`, dropping the item-log fields), for the endpoints that echo a single ask.
export function wireAsk(item: AskItem): Ask {
  return {
    id: item.id,
    createdAt: item.at,
    form: item.form,
    blocking: item.blocking,
    state: item.state,
    ...(item.prompt !== undefined ? { prompt: item.prompt } : {}),
    ...(item.answer !== undefined ? { answer: item.answer } : {}),
    ...(item.origin !== undefined ? { origin: item.origin } : {}),
  }
}

// The task's single open task-blocking ask, if any — what a wedged task is
// waiting on. Used by the CLI/view and to decide whether a fresh create/answer
// collides with one already open.
export function openTaskAsk(task: AskTask): AskItem | undefined {
  return askItems(task).find((a) => a.state === 'open' && a.blocking === 'task')
}

export function findAsk(task: AskTask, askId: string): AskItem | undefined {
  return askItems(task).find((a) => a.id === askId)
}

// The option the answer selected, for reading its `at` (scheduling) and its
// label/value (delivery). Undefined for an unanswered ask or an unmatched id.
export function chosenOption(ask: AskItem): AskOption | undefined {
  const optionId = ask.answer?.optionId
  return optionId ? ask.form.options.find((o) => o.id === optionId) : undefined
}

// Validate an answer against an ask's form and stamp it. Returns the answered
// ask, or an error result the endpoint maps to a status: 404 for an unknown ask,
// 409 for one that isn't open, 400 for an answer that doesn't fit the form.
// Mutates the ask (state + answer) in place; the endpoint owns the task-level
// un-wedge/queue/schedule that follows.
export function answerAsk(
  task: AskTask,
  askId: string,
  answer: { optionId?: string; text?: string; at: string },
): { ok: true; ask: AskItem } | { ok: false; error: string; status: 404 | 409 | 400 } {
  const ask = findAsk(task, askId)
  if (!ask) return { ok: false, error: 'ask not found', status: 404 }
  if (ask.state !== 'open')
    return { ok: false, error: `ask is already ${ask.state}`, status: 409 }
  const optionId = answer.optionId
  const text = answer.text
  if (!optionId) return { ok: false, error: 'an option id is required', status: 400 }
  if (!ask.form.options.some((o) => o.id === optionId))
    return { ok: false, error: `unknown option: ${optionId}`, status: 400 }
  // `text` rides along only for an editable option (the user-amended value); a
  // plain option carries none.
  ask.answer = {
    optionId,
    ...(text != null ? { text } : {}),
    at: answer.at,
  }
  ask.state = 'answered'
  return { ok: true, ask }
}

// The first line of an ask's prompt, for the delivery-message preamble.
function firstLine(prompt: string): string {
  const line = prompt.split('\n', 1)[0].trim()
  return line || prompt.trim()
}

// The value an answer conveys, in prose: the edited value of an editable option,
// else the chosen option's label. Used both for the delivered user message and
// anywhere an answer is echoed.
export function answerValue(ask: AskItem): string {
  const a = ask.answer
  if (!a) return ''
  const opt = chosenOption(ask)
  // An editable option delivers what the user typed (falling back to its
  // prefill); a plain option delivers its label.
  if (opt?.editable) return (a.text ?? opt.value ?? opt.label).trim()
  return opt?.label ?? a.optionId ?? ''
}

// The visible user message an answered ask delivers to the agent on re-entry, so
// the answer appears in the re-entry prompt. Null for an `origin: 'retry'` ask:
// the retry machinery composes the recovery turn itself (nudge or prompt
// re-send), which is the delivery. A promptless ask (the common agent wedge)
// delivers the bare value — the agent's own message was the question, so the
// answer reads naturally as the user's reply; a prompted ask names it. Assumes
// the ask has been answered.
export function answerDelivery(ask: AskItem): string | null {
  if (ask.origin === 'retry') return null
  const value = answerValue(ask)
  return ask.prompt ? `Answer to "${firstLine(ask.prompt)}": ${value}` : value
}

// Flip every open ask on the task to `withdrawn`. Called wherever the user's new
// intent supersedes a pending ask — a fresh /messages send, applyRelaunch, or a
// manual status change away from wedged — so a stale ask stops reading as open.
export function withdrawOpenAsks(task: AskTask): void {
  for (const a of askItems(task)) if (a.state === 'open') a.state = 'withdrawn'
}
