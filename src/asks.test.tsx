import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AskForm, askOptionLabel } from './asks'
import type { Ask } from './types'

const noLink = () => undefined
const AT = '2026-01-01T00:00:00.000Z'
const FUTURE = '2099-01-01T00:00:00.000Z'

const ask = (over: Partial<Ask> = {}): Ask => ({
  id: 'k1',
  createdAt: AT,
  form: { type: 'choice', options: [{ id: 'a', label: 'Alpha' }] },
  blocking: 'task',
  state: 'open',
  ...over,
})

const render = (a: Ask, disabled = false) =>
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
})
