import { describe, it, expect } from 'vitest'
import {
  validateAskForm,
  createAsk,
  answerAsk,
  answerDelivery,
  answerValue,
  chosenOption,
  openTaskAsk,
  withdrawOpenAsks,
  nextAskId,
  type AskForm,
  type AskTask,
} from './asks'

const AT = '2026-01-01T00:00:00.000Z'

const choice: AskForm = {
  type: 'choice',
  options: [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta', style: 'primary' },
  ],
}

const seed = (form: AskForm, over: Partial<Parameters<typeof createAsk>[1]> = {}) => {
  const task: AskTask = {}
  const ask = createAsk(task, {
    id: 'ask-1',
    prompt: 'Pick one',
    form,
    blocking: 'task',
    at: AT,
    ...over,
  })
  return { task, ask }
}

describe('validateAskForm', () => {
  it('accepts a well-formed choice form', () => {
    expect(validateAskForm(choice)).toBeNull()
  })

  it('rejects a missing/unknown form or an empty choice', () => {
    expect(validateAskForm(undefined)).toMatch(/required/)
    expect(validateAskForm({ type: 'nope' })).toMatch(/must be choice/)
    // Confirm/text forms were dropped as producerless — only choice validates.
    expect(validateAskForm({ type: 'confirm' })).toMatch(/must be choice/)
    expect(validateAskForm({ type: 'choice', options: [] })).toMatch(/at least one/)
  })

  it('rejects options missing an id/label, and duplicate ids', () => {
    expect(validateAskForm({ type: 'choice', options: [{ label: 'x' }] })).toMatch(
      /needs an id/,
    )
    expect(validateAskForm({ type: 'choice', options: [{ id: 'x' }] })).toMatch(
      /needs a label/,
    )
    expect(
      validateAskForm({
        type: 'choice',
        options: [
          { id: 'x', label: 'X' },
          { id: 'x', label: 'X2' },
        ],
      }),
    ).toMatch(/duplicate/)
  })
})

describe('nextAskId', () => {
  it('mints ask-<epoch36>-<seq> counting existing asks', () => {
    const task: AskTask = {}
    const a = nextAskId(task, 0)
    expect(a).toBe('ask-0-0')
    createAsk(task, { id: a, prompt: 'p', form: choice, blocking: 'task', at: AT })
    expect(nextAskId(task, 36)).toBe('ask-10-1')
  })
})

describe('createAsk', () => {
  it('appends an open ask and returns it', () => {
    const { task, ask } = seed(choice)
    expect(ask.state).toBe('open')
    expect(task.asks).toEqual([ask])
    expect(openTaskAsk(task)).toBe(ask)
  })

  it('carries origin when given', () => {
    const { ask } = seed(choice, { origin: 'retry' })
    expect(ask.origin).toBe('retry')
  })
})

describe('answerAsk', () => {
  it('stamps a valid choice answer and marks it answered', () => {
    const { task, ask } = seed(choice)
    const res = answerAsk(task, ask.id, { optionId: 'b', at: AT })
    expect(res.ok).toBe(true)
    expect(ask.state).toBe('answered')
    expect(ask.answer).toEqual({ optionId: 'b', at: AT })
    // The ask is no longer the task's open one.
    expect(openTaskAsk(task)).toBeUndefined()
  })

  it('404s an unknown ask and 409s one already answered', () => {
    const { task, ask } = seed(choice)
    expect(answerAsk(task, 'nope', { optionId: 'a', at: AT })).toMatchObject({
      ok: false,
      status: 404,
    })
    answerAsk(task, ask.id, { optionId: 'a', at: AT })
    expect(answerAsk(task, ask.id, { optionId: 'a', at: AT })).toMatchObject({
      ok: false,
      status: 409,
    })
  })

  it('400s a choice answer with no/unknown option', () => {
    const { task, ask } = seed(choice)
    expect(answerAsk(task, ask.id, { at: AT })).toMatchObject({ status: 400 })
    expect(answerAsk(task, ask.id, { optionId: 'z', at: AT })).toMatchObject({
      status: 400,
    })
  })

})

describe('answerValue / answerDelivery', () => {
  it('delivers the chosen option label with the prompt preamble', () => {
    const { task, ask } = seed(choice, { prompt: 'Deploy to prod?\nmore detail' })
    answerAsk(task, ask.id, { optionId: 'a', at: AT })
    expect(answerValue(ask)).toBe('Alpha')
    // Preamble is the first line of the prompt.
    expect(answerDelivery(ask)).toBe('Answer to "Deploy to prod?": Alpha')
  })

  it('delivers the edited value of an editable option, falling back to its prefill', () => {
    const form: AskForm = {
      type: 'choice',
      options: [{ id: 'rule', label: 'Grant', value: 'git log', editable: true }],
    }
    const { task, ask } = seed(form, { prompt: 'Grant a rule' })
    answerAsk(task, ask.id, { optionId: 'rule', text: 'git:*', at: AT })
    expect(answerValue(ask)).toBe('git:*')
    expect(chosenOption(ask)?.id).toBe('rule')
  })

  it('delivers nothing for an origin:retry ask (recovery composes the turn)', () => {
    const { task, ask } = seed(choice, { origin: 'retry' })
    answerAsk(task, ask.id, { optionId: 'a', at: AT })
    expect(answerDelivery(ask)).toBeNull()
  })

  it('delivers the bare value for a promptless ask (the message was the question)', () => {
    const { task, ask } = seed(choice, { prompt: undefined })
    expect(ask.prompt).toBeUndefined()
    answerAsk(task, ask.id, { optionId: 'a', at: AT })
    expect(answerDelivery(ask)).toBe('Alpha')
  })
})

describe('withdrawOpenAsks', () => {
  it('flips only open asks to withdrawn, leaving answered ones', () => {
    const task: AskTask = {}
    const open = createAsk(task, {
      id: 'o',
      prompt: 'p',
      form: choice,
      blocking: 'task',
      at: AT,
    })
    const done = createAsk(task, {
      id: 'd',
      prompt: 'p',
      form: choice,
      blocking: 'task',
      at: AT,
    })
    answerAsk(task, 'd', { optionId: 'a', at: AT })
    withdrawOpenAsks(task)
    expect(open.state).toBe('withdrawn')
    expect(done.state).toBe('answered')
    expect(openTaskAsk(task)).toBeUndefined()
  })
})
