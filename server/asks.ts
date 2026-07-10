// The Ask primitive: a stored question (choice/confirm/text) the platform or a
// task raises, and the pure helpers that create, answer, and withdraw them. An
// ask interleaves with messages/events in the client timeline by `createdAt`,
// exactly like a TaskEvent — a third parallel array on the task. Kept pure and
// structurally typed (like tasks.ts) so it unit-tests without the server: the
// endpoints in index.ts own the wedge/queue/schedule side-effects, these own the
// ask shape and the routing decisions.

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

export type AskForm =
  | { type: 'choice'; options: AskOption[] }
  | { type: 'confirm'; confirmLabel?: string; denyLabel?: string }
  | { type: 'text'; placeholder?: string; multiline?: boolean }

export type Ask = {
  // ask-<epoch36>-<seq>, minted by the caller of createAsk from the current
  // clock and the task's existing ask count.
  id: string
  createdAt: string
  prompt: string // markdown
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

// The confirm form's default button labels when it names none.
export const CONFIRM_YES = 'confirm'
export const CONFIRM_NO = 'deny'

// The platform retry ask's option ids: retry immediately, or (usage-limit only)
// schedule the retry for when the limit resets. The answer endpoint routes an
// origin:'retry' ask through applyRetryRecovery keyed on which was chosen.
export const RETRY_NOW = 'retry-now'
export const RETRY_AT_RESET = 'retry-at-reset'

// The task slice the ask helpers read and write. index.ts's Task satisfies this
// structurally, so it passes its own value; the structural shape also lets the
// helpers be tested against minimal fixtures.
export type AskTask = { asks?: Ask[] }

// Validate a form's shape for the create endpoint. Returns an error string (for
// a 400) or null when well-formed. Guards exactly what the renderer/answer path
// assumes: choice needs at least one option, each with a non-empty id + label
// and unique ids; confirm/text carry only optional strings.
export function validateAskForm(form: unknown): string | null {
  if (!form || typeof form !== 'object') return 'form is required'
  const f = form as { type?: unknown }
  if (f.type === 'choice') {
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
  if (f.type === 'confirm' || f.type === 'text') return null
  return 'form.type must be one of choice, confirm, text'
}

// Mint the id for the next ask on a task: `ask-<epoch36>-<seq>`, where seq is the
// task's current ask count (so ids stay stable and ordered within a task).
export function nextAskId(task: AskTask, nowMs: number): string {
  return `ask-${Math.floor(nowMs).toString(36)}-${task.asks?.length ?? 0}`
}

// Build an open ask and append it to the task, returning it. Assumes the form
// has already passed validateAskForm (the create endpoint checks and 400s first;
// createAsk is the plumbing that stamps state and pushes). `origin` marks a
// platform retry ask.
export function createAsk(
  task: AskTask,
  opts: {
    id: string
    prompt: string
    form: AskForm
    blocking: Ask['blocking']
    origin?: 'retry'
    at: string
  },
): Ask {
  const ask: Ask = {
    id: opts.id,
    createdAt: opts.at,
    prompt: opts.prompt,
    form: opts.form,
    blocking: opts.blocking,
    state: 'open',
    ...(opts.origin ? { origin: opts.origin } : {}),
  }
  ;(task.asks ??= []).push(ask)
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
): Ask {
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

// The task's single open task-blocking ask, if any — what a wedged task is
// waiting on. Used by the CLI/view and to decide whether a fresh create/answer
// collides with one already open.
export function openTaskAsk(task: AskTask): Ask | undefined {
  return task.asks?.find((a) => a.state === 'open' && a.blocking === 'task')
}

export function findAsk(task: AskTask, askId: string): Ask | undefined {
  return task.asks?.find((a) => a.id === askId)
}

// The option a choice/confirm answer selected, for reading its `at` (scheduling)
// and its label/value (delivery). Undefined for a text form or an unmatched id.
export function chosenOption(ask: Ask): AskOption | undefined {
  if (ask.form.type !== 'choice') return undefined
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
): { ok: true; ask: Ask } | { ok: false; error: string; status: 404 | 409 | 400 } {
  const ask = findAsk(task, askId)
  if (!ask) return { ok: false, error: 'ask not found', status: 404 }
  if (ask.state !== 'open')
    return { ok: false, error: `ask is already ${ask.state}`, status: 409 }
  const optionId = answer.optionId
  const text = answer.text
  if (ask.form.type === 'choice') {
    if (!optionId) return { ok: false, error: 'an option id is required', status: 400 }
    if (!ask.form.options.some((o) => o.id === optionId))
      return { ok: false, error: `unknown option: ${optionId}`, status: 400 }
  } else if (ask.form.type === 'confirm') {
    if (optionId !== CONFIRM_YES && optionId !== CONFIRM_NO)
      return {
        ok: false,
        error: `a confirm answer must be "${CONFIRM_YES}" or "${CONFIRM_NO}"`,
        status: 400,
      }
  } else {
    if (!text || !text.trim())
      return { ok: false, error: 'answer text is required', status: 400 }
  }
  ask.answer = {
    ...(optionId ? { optionId } : {}),
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
// else the chosen option's label, else the confirm/text answer. Used both for
// the delivered user message and anywhere an answer is echoed.
export function answerValue(ask: Ask): string {
  const a = ask.answer
  if (!a) return ''
  if (ask.form.type === 'choice') {
    const opt = chosenOption(ask)
    // An editable option delivers what the user typed (falling back to its
    // prefill); a plain option delivers its label.
    if (opt?.editable) return (a.text ?? opt.value ?? opt.label).trim()
    return opt?.label ?? a.optionId ?? ''
  }
  if (ask.form.type === 'confirm') {
    if (a.optionId === CONFIRM_YES) return ask.form.confirmLabel ?? 'Yes'
    return ask.form.denyLabel ?? 'No'
  }
  return (a.text ?? '').trim()
}

// The visible user message an answered ask delivers to the agent on re-entry, so
// the answer appears in the re-entry prompt. Null for an `origin: 'retry'` ask:
// the retry machinery composes the recovery turn itself (nudge or prompt
// re-send), which is the delivery. Assumes the ask has been answered.
export function answerDelivery(ask: Ask): string | null {
  if (ask.origin === 'retry') return null
  return `Answer to "${firstLine(ask.prompt)}": ${answerValue(ask)}`
}

// Flip every open ask on the task to `withdrawn`. Called wherever the user's new
// intent supersedes a pending ask — a fresh /messages send, applyRelaunch, or a
// manual status change away from wedged — so a stale ask stops reading as open.
export function withdrawOpenAsks(task: AskTask): void {
  for (const a of task.asks ?? []) if (a.state === 'open') a.state = 'withdrawn'
}
