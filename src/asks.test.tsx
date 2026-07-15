import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AskForm, askOptionLabel } from './asks'
import type { AskItem } from './types'

const noLink = () => undefined
const AT = '2026-01-01T00:00:00.000Z'
const FUTURE = '2099-01-01T00:00:00.000Z'

const ask = (over: Partial<AskItem> = {}): AskItem => ({
  id: 'k1',
  at: AT,
  kind: 'ask',
  form: { type: 'choice', options: [{ id: 'a', label: 'Alpha' }] },
  blocking: 'task',
  state: 'open',
  ...over,
})

const render = (a: AskItem, disabled = false) =>
  renderToStaticMarkup(
    <AskForm ask={a} linkTask={noLink} disabled={disabled} onAnswer={() => {}} />,
  )

describe('askOptionLabel', () => {
  it('appends a future option clock, and leaves a plain label once past', () => {
    expect(askOptionLabel({ id: 'x', label: 'Retry at reset', at: FUTURE })).toMatch(
      /Retry at reset \(/,
    )
    expect(askOptionLabel({ id: 'x', label: 'Retry now', at: AT })).toBe('Retry now')
    expect(askOptionLabel({ id: 'x', label: 'Plain' })).toBe('Plain')
  })
})

describe('AskForm rendering', () => {
  it('renders choice options as buttons, carrying the style class, with no card wrapper', () => {
    const html = render(
      ask({
        form: {
          type: 'choice',
          options: [
            { id: 'go', label: 'Ship', style: 'primary' },
            { id: 'stop', label: 'Abort', style: 'danger' },
          ],
        },
      }),
    )
    expect(html).toContain('Ship')
    expect(html).toContain('ask-option-primary')
    expect(html).toContain('ask-option-danger')
    // No standalone card chrome — the form hangs off the message.
    expect(html).not.toContain('ask-card')
  })

  it('omits a prompt line when the ask has none, and shows it when present', () => {
    expect(render(ask())).not.toContain('ask-prompt')
    expect(render(ask({ prompt: 'Usage limit reached.' }))).toContain(
      'Usage limit reached.',
    )
  })

  it('prefills an editable option input with its value', () => {
    const html = render(
      ask({
        form: {
          type: 'choice',
          options: [{ id: 'r', label: 'Grant', value: 'git log', editable: true }],
        },
      }),
    )
    expect(html).toContain('ask-input')
    expect(html).toContain('value="git log"')
  })

  it('disables every control while an answer is in flight', () => {
    const html = render(ask(), true)
    expect(html).toContain('disabled')
  })

  // The prompt and the form have different lifetimes: a platform prompt states
  // what happened and is the conversation's record of it, so it outlives the
  // buttons it was raised with.
  it.each(['answered', 'withdrawn'] as const)(
    'keeps the prompt but drops the form once %s',
    (state) => {
      const html = render(
        ask({ state, prompt: 'This ride was killed by a daemon update.' }),
      )
      expect(html).toContain('This ride was killed by a daemon update.')
      expect(html).not.toContain('ask-form')
      expect(html).not.toContain('Alpha')
    },
  )
})
