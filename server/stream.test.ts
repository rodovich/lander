import { describe, it, expect } from 'vitest'
import {
  summarizeToolInput,
  toolRule,
  diffEdits,
  rawToolResultText,
  summarizeToolResult,
  reduceStreamLine,
} from './stream'

// A fixed timestamp the reducer must thread through verbatim — it never reads a
// clock, which is the property that lets the same reduction serve a live run and
// a log replayed from disk.
const AT = '2026-01-01T00:00:00.000Z'

describe('summarizeToolInput', () => {
  it('returns empty string for non-object input', () => {
    expect(summarizeToolInput(null)).toBe('')
    expect(summarizeToolInput(undefined)).toBe('')
    expect(summarizeToolInput('str')).toBe('')
    expect(summarizeToolInput(42)).toBe('')
  })

  it('prefers identifying fields in precedence order', () => {
    expect(summarizeToolInput({ file_path: '/a', path: '/b' })).toBe('/a')
    expect(summarizeToolInput({ path: '/b', command: 'ls' })).toBe('/b')
    expect(summarizeToolInput({ command: 'ls', pattern: 'p' })).toBe('ls')
    expect(summarizeToolInput({ pattern: 'p', query: 'q' })).toBe('p')
    expect(summarizeToolInput({ query: 'q', url: 'u' })).toBe('q')
    expect(summarizeToolInput({ url: 'u', description: 'd' })).toBe('u')
    expect(summarizeToolInput({ description: 'd' })).toBe('d')
  })

  it('includes description (unlike toolRule)', () => {
    // Deliberate divergence from toolRule, which omits description.
    expect(summarizeToolInput({ description: 'do a thing' })).toBe('do a thing')
    expect(toolRule('X', { description: 'do a thing' })).toBe('X')
  })

  it('falls back to compact JSON when no known field is present', () => {
    expect(summarizeToolInput({ foo: 'bar' })).toBe('{"foo":"bar"}')
  })

  it('skips non-string field values and falls through', () => {
    // file_path is present but not a string, so it is ignored.
    expect(summarizeToolInput({ file_path: 123, command: 'ls' })).toBe('ls')
  })

  it('collapses whitespace and trims', () => {
    expect(summarizeToolInput({ command: '  a   b\n\tc  ' })).toBe('a b c')
  })

  it('truncates to 200 chars with an ellipsis', () => {
    const out = summarizeToolInput({ command: 'x'.repeat(300) })
    expect(out).toBe('x'.repeat(200) + '…')
    expect(out.length).toBe(201)
  })
})

describe('toolRule', () => {
  it('returns the bare tool name for non-object input', () => {
    expect(toolRule('Read', null)).toBe('Read')
    expect(toolRule('Read', 'str')).toBe('Read')
  })

  it('prefers command then file_path/path then pattern/query/url', () => {
    expect(toolRule('Bash', { command: 'npm test', file_path: '/x' })).toBe(
      'Bash(npm test)',
    )
    expect(toolRule('Read', { file_path: '/x', path: '/y' })).toBe('Read(/x)')
    expect(toolRule('Read', { path: '/y' })).toBe('Read(/y)')
    expect(toolRule('Grep', { pattern: 'foo' })).toBe('Grep(foo)')
    expect(toolRule('X', { query: 'q' })).toBe('X(q)')
    expect(toolRule('X', { url: 'u' })).toBe('X(u)')
  })

  it('returns a bare name when no specifier field is present', () => {
    expect(toolRule('TodoWrite', { todos: [] })).toBe('TodoWrite')
  })

  it('does not truncate the specifier (the grant must be exact)', () => {
    const cmd = 'echo ' + 'x'.repeat(500)
    expect(toolRule('Bash', { command: cmd })).toBe(`Bash(${cmd})`)
  })
})

describe('diffEdits', () => {
  it('returns undefined for non-object input', () => {
    expect(diffEdits('Edit', null)).toBeUndefined()
  })

  it('returns undefined for non-file-writing tools', () => {
    expect(diffEdits('Read', { file_path: '/x' })).toBeUndefined()
  })

  it('Edit: one hunk from old_string/new_string', () => {
    expect(diffEdits('Edit', { old_string: 'a', new_string: 'b' })).toEqual([
      { old: 'a', new: 'b' },
    ])
  })

  it('Edit: undefined when either string is missing or non-string', () => {
    expect(diffEdits('Edit', { old_string: 'a' })).toBeUndefined()
    expect(diffEdits('Edit', { old_string: 'a', new_string: 5 })).toBeUndefined()
  })

  it('Write: single hunk against an empty original', () => {
    expect(diffEdits('Write', { content: 'hello' })).toEqual([
      { old: '', new: 'hello' },
    ])
  })

  it('Write: undefined when content is not a string', () => {
    expect(diffEdits('Write', { content: 123 })).toBeUndefined()
  })

  it('MultiEdit: one hunk per entry, non-object entries filtered out', () => {
    expect(
      diffEdits('MultiEdit', {
        edits: [
          { old_string: 'a', new_string: 'b' },
          null,
          'nope',
          { old_string: 'c', new_string: 'd' },
        ],
      }),
    ).toEqual([
      { old: 'a', new: 'b' },
      { old: 'c', new: 'd' },
    ])
  })

  it('MultiEdit: missing entry fields cap to empty string', () => {
    expect(diffEdits('MultiEdit', { edits: [{}] })).toEqual([
      { old: '', new: '' },
    ])
  })

  it('caps each side at 4000 chars with a newline ellipsis', () => {
    const big = 'x'.repeat(5000)
    const [hunk] = diffEdits('Write', { content: big })!
    expect(hunk.new).toBe('x'.repeat(4000) + '\n…')
    expect(hunk.old).toBe('')
  })
})

describe('rawToolResultText', () => {
  it('returns a plain string verbatim, preserving newlines', () => {
    expect(rawToolResultText('a\nb')).toBe('a\nb')
  })

  it('concatenates array block text with no separator', () => {
    expect(
      rawToolResultText([
        { type: 'text', text: 'foo' },
        { type: 'text', text: 'bar' },
      ]),
    ).toBe('foobar')
  })

  it('contributes empty string for blocks without text (e.g. images)', () => {
    expect(
      rawToolResultText([
        { type: 'text', text: 'foo' },
        { type: 'image' },
        null,
      ]),
    ).toBe('foo')
  })

  it('returns empty string for anything else', () => {
    expect(rawToolResultText(null)).toBe('')
    expect(rawToolResultText(42)).toBe('')
    expect(rawToolResultText({ text: 'x' })).toBe('')
  })
})

describe('summarizeToolResult', () => {
  it('preserves newlines for short multi-line output (<=3 lines)', () => {
    expect(summarizeToolResult('one\ntwo\nthree')).toBe('one\ntwo\nthree')
  })

  it('trims leading/trailing whitespace before capping', () => {
    expect(summarizeToolResult('  hi  ')).toBe('hi')
  })

  it('line-caps at 3 lines with the ellipsis on its own line', () => {
    expect(summarizeToolResult('a\nb\nc\nd')).toBe('a\nb\nc\n…')
  })

  it('char-caps at 200 with an inline ellipsis when <=3 lines', () => {
    const out = summarizeToolResult('b'.repeat(250))
    expect(out).toBe('b'.repeat(200) + '…')
  })

  it('line cap wins over char cap when the 200-char slice exceeds 3 lines', () => {
    // Five 50-char lines (254 chars). The >200 char cap slices to 200, which
    // still spans 4 lines, so the line cap fires and the inline ellipsis is
    // dropped — only the first three lines plus a newline ellipsis remain.
    const input = Array(5).fill('a'.repeat(50)).join('\n')
    const line = 'a'.repeat(50)
    expect(summarizeToolResult(input)).toBe([line, line, line].join('\n') + '\n…')
  })
})

describe('reduceStreamLine', () => {
  it('returns no steps and no finalText for invalid JSON', () => {
    const r = reduceStreamLine('not json', AT)
    expect(r.steps).toEqual([])
    expect(r.finalText).toBeUndefined()
  })

  it('ignores unknown event types and non-array content', () => {
    expect(reduceStreamLine(JSON.stringify({ type: 'system' }), AT)).toEqual({
      steps: [],
      finalText: undefined,
    })
    expect(
      reduceStreamLine(
        JSON.stringify({ type: 'assistant', message: { content: 'x' } }),
        AT,
      ).steps,
    ).toEqual([])
  })

  it('turns an assistant text block into a text step and sets finalText', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
      AT,
    )
    expect(r.steps).toEqual([{ kind: 'text', text: 'hello', createdAt: AT }])
    expect(r.finalText).toBe('hello')
  })

  it('emits no step for an empty text block', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '' }] },
      }),
      AT,
    )
    expect(r.steps).toEqual([])
    expect(r.finalText).toBeUndefined()
  })

  it('finalText is last-wins across blocks in one line', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
          ],
        },
      }),
      AT,
    )
    expect(r.steps).toHaveLength(2)
    expect(r.finalText).toBe('second')
  })

  it('builds a tool_use step with rule and edits', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              id: 'tu_1',
              input: { file_path: '/a', old_string: 'x', new_string: 'y' },
            },
          ],
        },
      }),
      AT,
    )
    expect(r.steps).toEqual([
      {
        kind: 'tool_use',
        tool: 'Edit',
        input: '/a',
        toolUseId: 'tu_1',
        rule: 'Edit(/a)',
        edits: [{ old: 'x', new: 'y' }],
        createdAt: AT,
      },
    ])
  })

  it('stamps text and tool_use steps with the inference (message) id', () => {
    // One inference emitting a parallel batch: a text block plus two tool calls,
    // all sharing the assistant message id. A change in this id — not adjacency —
    // is what marks a turn boundary downstream.
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_xyz',
          content: [
            { type: 'text', text: 'on it' },
            { type: 'tool_use', name: 'Read', id: 'tu_1', input: { file_path: '/a' } },
            { type: 'tool_use', name: 'Read', id: 'tu_2', input: { file_path: '/b' } },
          ],
        },
      }),
      AT,
    )
    expect(r.steps.map((s) => s.inferenceId)).toEqual(['msg_xyz', 'msg_xyz', 'msg_xyz'])
  })

  it('leaves inferenceId undefined when the message carries no id', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'hi' }],
        },
      }),
      AT,
    )
    expect(r.steps[0].inferenceId).toBeUndefined()
  })

  it('does not put an inferenceId on tool_result steps', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'user',
        message: {
          id: 'msg_user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
        },
      }),
      AT,
    )
    expect(r.steps[0].inferenceId).toBeUndefined()
  })

  it('preserves block order across mixed content', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'thinking' },
            { type: 'tool_use', name: 'Read', id: 'tu_2', input: { file_path: '/f' } },
          ],
        },
      }),
      AT,
    )
    expect(r.steps.map((s) => s.kind)).toEqual(['text', 'tool_use'])
  })

  it('builds a tool_result step without inferring blocked from its text', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'permission denied',
              is_error: true,
            },
          ],
        },
      }),
      AT,
    )
    // blocked is set later, from the terminal result event's permission_denials
    // list — never guessed from the result text here.
    expect(r.steps).toEqual([
      {
        kind: 'tool_result',
        text: 'permission denied',
        toolUseId: 'tu_1',
        isError: true,
        createdAt: AT,
      },
    ])
    expect(r.steps[0].blocked).toBeUndefined()
  })

  it('surfaces blockedIds from the result event permission_denials', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'result',
        result: 'done',
        permission_denials: [
          { tool_name: 'Bash', tool_use_id: 'tu_1', tool_input: { command: 'x' } },
          { tool_name: 'Read', tool_use_id: 'tu_2', tool_input: {} },
        ],
      }),
      AT,
    )
    expect(r.blockedIds).toEqual(['tu_1', 'tu_2'])
    expect(r.finalText).toBe('done')
  })

  it('omits blockedIds when the result event has no permission_denials', () => {
    const r = reduceStreamLine(
      JSON.stringify({ type: 'result', result: 'done' }),
      AT,
    )
    expect(r.blockedIds).toBeUndefined()
  })

  it('treats is_error strictly: only === true counts as an error', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't', content: 'x', is_error: 1 },
          ],
        },
      }),
      AT,
    )
    expect(r.steps[0]).toMatchObject({ isError: false })
  })

  it('takes finalText from a string result event, with no steps', () => {
    const r = reduceStreamLine(
      JSON.stringify({ type: 'result', result: 'the answer' }),
      AT,
    )
    expect(r.steps).toEqual([])
    expect(r.finalText).toBe('the answer')
  })

  it('ignores a non-string result', () => {
    const r = reduceStreamLine(JSON.stringify({ type: 'result', result: 42 }), AT)
    expect(r.finalText).toBeUndefined()
    expect(r.steps).toEqual([])
  })

  it('pulls token usage and the dominant model from a result event', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'result',
        result: 'done',
        usage: {
          input_tokens: 913,
          output_tokens: 15376,
          cache_read_input_tokens: 181274,
          cache_creation_input_tokens: 21296,
        },
        modelUsage: {
          'claude-haiku-4-5': { outputTokens: 40 },
          'claude-opus-4-8': { outputTokens: 15336 },
        },
      }),
      AT,
    )
    expect(r.usage).toEqual({
      input: 913,
      output: 15376,
      cacheRead: 181274,
      cacheCreation: 21296,
      model: 'claude-opus-4-8',
    })
  })

  it('defaults missing usage fields to zero and leaves model undefined', () => {
    const r = reduceStreamLine(
      JSON.stringify({ type: 'result', result: 'done', usage: { output_tokens: 5 } }),
      AT,
    )
    expect(r.usage).toEqual({
      input: 0,
      output: 5,
      cacheRead: 0,
      cacheCreation: 0,
      model: undefined,
    })
  })

  it('leaves usage undefined when a result event carries none', () => {
    const r = reduceStreamLine(JSON.stringify({ type: 'result', result: 'done' }), AT)
    expect(r.usage).toBeUndefined()
  })
})
