// The ask renderer: a card in the conversation timeline for a stored question.
// An open task-blocking ask shows its prompt and its form (choice buttons /
// confirm / text input) and posts the answer; an answered or withdrawn ask
// renders as a quiet record. Mirrors the grants module's shape — a small
// self-contained component with a pure helper — so it unit-tests via SSR.

import { useState } from 'react'
import { retryResetTime } from './format'
import { Markdown } from './markdown'
import type { TaskLinkResolver } from './markdown'
import type { Ask, AskOption } from './types'

// The confirm form's option ids, matching the server (asks.ts CONFIRM_YES/NO).
const CONFIRM_YES = 'confirm'
const CONFIRM_NO = 'deny'

// An option's display label, appending its scheduled clock time while that time
// is still in the future (e.g. "Retry when the limit resets (3:00 PM)"); once
// past, the option answers immediately and the bare label reads right. This is
// the retry bar's old reset-time logic, generalized to any at-carrying option.
export function askOptionLabel(opt: AskOption): string {
  const clock = retryResetTime({ resetsAt: opt.at })
  return clock ? `${opt.label} (${clock})` : opt.label
}

// What an answered ask conveys, in prose, for its quiet record: the edited value
// of an editable option, else the chosen option's label, else the confirm/text
// answer. Mirrors the server's answerValue.
export function answeredValue(ask: Ask): string {
  const a = ask.answer
  if (!a) return ''
  if (ask.form.type === 'choice') {
    const opt = ask.form.options.find((o) => o.id === a.optionId)
    if (opt?.editable) return (a.text ?? opt.value ?? opt.label).trim()
    return opt?.label ?? a.optionId ?? ''
  }
  if (ask.form.type === 'confirm')
    return a.optionId === CONFIRM_YES
      ? (ask.form.confirmLabel ?? 'Yes')
      : (ask.form.denyLabel ?? 'No')
  return (a.text ?? '').trim()
}

export function AskCard({
  ask,
  linkTask,
  disabled,
  onAnswer,
}: {
  ask: Ask
  linkTask: TaskLinkResolver
  // True while an answer to this task's ask is in flight (the same per-task
  // in-flight disabling the composer uses), so the buttons can't double-submit.
  disabled: boolean
  onAnswer: (body: { optionId?: string; text?: string }) => void
}) {
  // Per-editable-option text, seeded from each option's prefill; and the free
  // text form's input. Both are only meaningful for an open ask.
  const [edited, setEdited] = useState<Record<string, string>>(() =>
    ask.form.type === 'choice'
      ? Object.fromEntries(
          ask.form.options
            .filter((o) => o.editable)
            .map((o) => [o.id, o.value ?? '']),
        )
      : {},
  )
  const [textValue, setTextValue] = useState('')

  return (
    <div className={`ask-card ask-${ask.state}`}>
      <div className="ask-prompt">
        <Markdown text={ask.prompt} linkTask={linkTask} />
      </div>
      {ask.state === 'open' ? (
        <div className="ask-form">
          {ask.form.type === 'choice' &&
            ask.form.options.map((opt) =>
              opt.editable ? (
                <div className="ask-editable" key={opt.id}>
                  <input
                    className="ask-input"
                    value={edited[opt.id] ?? ''}
                    disabled={disabled}
                    onChange={(e) =>
                      setEdited((prev) => ({ ...prev, [opt.id]: e.target.value }))
                    }
                  />
                  <button
                    type="button"
                    className={optionClass(opt)}
                    disabled={disabled || !(edited[opt.id] ?? '').trim()}
                    onClick={() =>
                      onAnswer({ optionId: opt.id, text: edited[opt.id] ?? '' })
                    }
                  >
                    {askOptionLabel(opt)}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className={optionClass(opt)}
                  key={opt.id}
                  disabled={disabled}
                  title={opt.detail}
                  onClick={() => onAnswer({ optionId: opt.id })}
                >
                  {askOptionLabel(opt)}
                </button>
              ),
            )}
          {ask.form.type === 'confirm' && (
            <>
              <button
                type="button"
                className="ask-option ask-option-primary"
                disabled={disabled}
                onClick={() => onAnswer({ optionId: CONFIRM_YES })}
              >
                {ask.form.confirmLabel ?? 'Yes'}
              </button>
              <button
                type="button"
                className="ask-option"
                disabled={disabled}
                onClick={() => onAnswer({ optionId: CONFIRM_NO })}
              >
                {ask.form.denyLabel ?? 'No'}
              </button>
            </>
          )}
          {ask.form.type === 'text' && (
            <div className="ask-text-form">
              <input
                className="ask-input"
                placeholder={ask.form.placeholder}
                value={textValue}
                disabled={disabled}
                onChange={(e) => setTextValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && textValue.trim() && !disabled)
                    onAnswer({ text: textValue })
                }}
              />
              <button
                type="button"
                className="ask-option ask-option-primary"
                disabled={disabled || !textValue.trim()}
                onClick={() => onAnswer({ text: textValue })}
              >
                Answer
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="ask-record">
          {ask.state === 'withdrawn'
            ? 'Withdrawn'
            : `Answered: ${answeredValue(ask)}`}
        </div>
      )}
    </div>
  )
}

function optionClass(opt: AskOption): string {
  return 'ask-option' + (opt.style ? ` ask-option-${opt.style}` : '')
}
