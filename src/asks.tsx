// The ask form: the controls for an open ask, rendered inline under the assistant
// message it belongs to (not as a separate card). An agent wedge carries no
// prompt — its own message is the question — so this usually renders just the
// buttons; a platform ask (the retry ask) carries a prompt line above them.

import { useState } from 'react'
import { retryResetTime } from './format'
import { Markdown } from './markdown'
import type { TaskLinkResolver } from './markdown'
import type { AskItem, AskOption } from './types'

// An option's display label, appending its scheduled clock time while that time
// is still in the future (e.g. "Retry when the limit resets (3:00 PM)"); once
// past, the option answers immediately and the bare label reads right. This is
// the retry bar's old reset-time logic, generalized to any at-carrying option.
export function askOptionLabel(opt: AskOption): string {
  const clock = retryResetTime({ resetsAt: opt.at })
  return clock ? `${opt.label} (${clock})` : opt.label
}

export function AskForm({
  ask,
  linkTask,
  disabled,
  onAnswer,
}: {
  ask: AskItem
  linkTask: TaskLinkResolver
  // True while an answer to this task's ask is in flight (the same per-task
  // in-flight disabling the composer uses), so the buttons can't double-submit.
  disabled: boolean
  onAnswer: (body: { optionId?: string; text?: string }) => void
}) {
  // Per-editable-option text, seeded from each option's prefill.
  const [edited, setEdited] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      ask.form.options.filter((o) => o.editable).map((o) => [o.id, o.value ?? '']),
    ),
  )

  return (
    <div className="ask">
      {ask.prompt && (
        <div className="ask-prompt">
          <Markdown text={ask.prompt} linkTask={linkTask} />
        </div>
      )}
      <div className="ask-form">
        {ask.form.options.map((opt) =>
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
      </div>
    </div>
  )
}

function optionClass(opt: AskOption): string {
  return 'ask-option' + (opt.style ? ` ask-option-${opt.style}` : '')
}
