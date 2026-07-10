import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AskCard, askOptionLabel, answeredValue } from './asks'
import type { Ask } from './types'

const noLink = () => undefined
const AT = '2026-01-01T00:00:00.000Z'
const FUTURE = '2099-01-01T00:00:00.000Z'

const ask = (over: Partial<Ask> = {}): Ask => ({
  id: 'k1',
  createdAt: AT,
  prompt: 'Pick one',
  form: { type: 'choice', options: [{ id: 'a', label: 'Alpha' }] },
  blocking: 'task',
  state: 'open',
  ...over,
})

const render = (a: Ask, disabled = false) =>
  renderToStaticMarkup(
    <AskCard ask={a} linkTask={noLink} disabled={disabled} onAnswer={() => {}} />,
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

describe('answeredValue', () => {
  it('reads a chosen option label', () => {
    const a = ask({
      state: 'answered',
      form: { type: 'choice', options: [{ id: 'a', label: 'Alpha' }] },
      answer: { optionId: 'a', at: AT },
    })
    expect(answeredValue(a)).toBe('Alpha')
  })

  it('reads the edited value of an editable option (round-trip)', () => {
    const a = ask({
      state: 'answered',
      form: {
        type: 'choice',
        options: [{ id: 'r', label: 'Grant', value: 'git log', editable: true }],
      },
      answer: { optionId: 'r', text: 'git:*', at: AT },
    })
    expect(answeredValue(a)).toBe('git:*')
  })

  it('reads confirm and text answers', () => {
    expect(
      answeredValue(
        ask({
          state: 'answered',
          form: { type: 'confirm', confirmLabel: 'Ship it' },
          answer: { optionId: 'confirm', at: AT },
        }),
      ),
    ).toBe('Ship it')
    expect(
      answeredValue(
        ask({
          state: 'answered',
          form: { type: 'text' },
          answer: { text: 'a name', at: AT },
        }),
      ),
    ).toBe('a name')
  })
})

describe('AskCard rendering', () => {
  it('renders choice options as buttons, carrying the style class', () => {
    const html = render(
      ask({
        prompt: 'Deploy?',
        form: {
          type: 'choice',
          options: [
            { id: 'go', label: 'Ship', style: 'primary' },
            { id: 'stop', label: 'Abort', style: 'danger' },
          ],
        },
      }),
    )
    expect(html).toContain('Deploy?')
    expect(html).toContain('Ship')
    expect(html).toContain('ask-option-primary')
    expect(html).toContain('ask-option-danger')
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

  it('renders confirm as two buttons and text as an input + submit', () => {
    const confirm = render(
      ask({ form: { type: 'confirm', confirmLabel: 'Yes do it', denyLabel: 'No' } }),
    )
    expect(confirm).toContain('Yes do it')
    expect(confirm).toContain('No')

    const text = render(ask({ form: { type: 'text', placeholder: 'type here' } }))
    expect(text).toContain('placeholder="type here"')
    expect(text).toContain('Answer')
  })

  it('disables every control while an answer is in flight', () => {
    const html = render(
      ask({
        form: {
          type: 'choice',
          options: [{ id: 'a', label: 'Alpha' }],
        },
      }),
      true,
    )
    expect(html).toContain('disabled')
  })

  it('renders answered and withdrawn asks as quiet records, no buttons', () => {
    const answered = render(
      ask({
        state: 'answered',
        answer: { optionId: 'a', at: AT },
      }),
    )
    expect(answered).toContain('ask-answered')
    expect(answered).toContain('Answered: Alpha')
    expect(answered).not.toContain('ask-option')

    const withdrawn = render(ask({ state: 'withdrawn' }))
    expect(withdrawn).toContain('ask-withdrawn')
    expect(withdrawn).toContain('Withdrawn')
  })
})
