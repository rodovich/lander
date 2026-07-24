// The task prompt template carries an {{id}} slot so the agent is told its own
// task id up front — an agent that knows its id won't mistake its own row in
// `lander list` for a separate "sibling" task (see task DrNwYlXD7L). These lock
// the substitution and guard against a leftover placeholder reaching the child.

import { describe, expect, it } from 'vitest'
import {
  fillTaskPrompt,
  taskManagementPrompt,
  promptWithTaskManagement,
} from './task-management'

const TEMPLATE = 'You are running inside a lander task. This task id is {{id}}. {{forwardable}}.'

describe('fillTaskPrompt', () => {
  it('substitutes both {{id}} and {{forwardable}} and leaves no placeholder', () => {
    const out = fillTaskPrompt(TEMPLATE, 'FWD', 'abc123')
    expect(out).toContain('This task id is abc123.')
    expect(out).toContain('FWD.')
    expect(out).not.toContain('{{')
  })
})

describe('taskManagementPrompt / promptWithTaskManagement', () => {
  it('threads the id through (not the task object, which has no id)', () => {
    const task = { allowEdits: false }
    const managed = taskManagementPrompt(task, TEMPLATE, 'task-xyz')
    expect(managed).toContain('This task id is task-xyz.')
    expect(managed).not.toContain('{{id}}')
  })

  it('appends the caller prompt after the filled template', () => {
    const task = { allowEdits: true }
    const full = promptWithTaskManagement(task, 'DO THE THING', TEMPLATE, 'task-xyz')
    expect(full).toContain('This task id is task-xyz.')
    expect(full.endsWith('DO THE THING')).toBe(true)
  })
})
