import { describe, it, expect } from 'vitest'
import {
  summarizeToolInput,
  fullToolInput,
  toolRule,
  diffEdits,
  rawToolResultText,
  summarizeToolResult,
  reduceStreamLine,
  addUsage,
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

  it('leads an Agent summary with its subagent_type', () => {
    expect(
      summarizeToolInput({ subagent_type: 'Explore', description: 'find the reducer' }),
    ).toBe('Explore: find the reducer')
    // subagent_type alone (no description) still surfaces, not the JSON fallback.
    expect(summarizeToolInput({ subagent_type: 'Explore' })).toBe('Explore')
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

describe('fullToolInput', () => {
  it('returns empty string for non-object input', () => {
    expect(fullToolInput(null)).toBe('')
    expect(fullToolInput(undefined)).toBe('')
    expect(fullToolInput('str')).toBe('')
  })

  it('preserves newlines and internal whitespace, unlike summarizeToolInput', () => {
    const cmd = 'line one\n  line two\n\tline three'
    expect(fullToolInput({ command: cmd })).toBe(cmd)
    expect(summarizeToolInput({ command: cmd })).toBe('line one line two line three')
  })

  it('keeps the full text past the summary 200-char cap, up to 4k', () => {
    const out = fullToolInput({ command: 'x'.repeat(300) })
    expect(out).toBe('x'.repeat(300))
    expect(out.length).toBe(300)
  })

  it('caps at 4k with a trailing ellipsis on its own line', () => {
    const out = fullToolInput({ command: 'y'.repeat(5000) })
    expect(out).toBe('y'.repeat(4000) + '\n…')
  })

  it('uses the same field precedence and subagent lead as summarizeToolInput', () => {
    expect(fullToolInput({ path: '/b', command: 'ls' })).toBe('/b')
    expect(
      fullToolInput({ subagent_type: 'Explore', description: 'find\nthe reducer' }),
    ).toBe('Explore: find\nthe reducer')
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

  it('carries inputFull for a multi-line tool input, omitting it for short single-line ones', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              id: 'tu_ml',
              input: { command: 'echo one\necho two' },
            },
            {
              type: 'tool_use',
              name: 'Bash',
              id: 'tu_short',
              input: { command: 'ls' },
            },
          ],
        },
      }),
      AT,
    )
    // Multi-line: the chip summary collapses newlines, inputFull keeps them.
    expect(r.steps[0].input).toBe('echo one echo two')
    expect(r.steps[0].inputFull).toBe('echo one\necho two')
    // Short single-line: nothing to add over the chip, so no second copy.
    expect(r.steps[1].input).toBe('ls')
    expect(r.steps[1].inputFull).toBeUndefined()
  })

  it('carries inputFull for a tool input past the 200-char chip cap', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              id: 'tu_long',
              input: { command: 'z'.repeat(300) },
            },
          ],
        },
      }),
      AT,
    )
    expect(r.steps[0].input).toBe('z'.repeat(200) + '…')
    expect(r.steps[0].inputFull).toBe('z'.repeat(300))
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

  it('stamps a subagent event with parent_tool_use_id and keeps its text out of finalText', () => {
    // A subagent's assistant event: claude tags it with the spawning Agent/Explore
    // call's id. Both blocks carry parentToolUseId, and the subagent's prose must
    // NOT become the turn's reply text (that belongs to the main agent alone).
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'tu_agent',
        message: {
          id: 'msg_sub',
          content: [
            { type: 'text', text: 'subagent thinking' },
            { type: 'tool_use', name: 'Read', id: 'tu_inner', input: { file_path: '/f' } },
          ],
        },
      }),
      AT,
    )
    expect(r.steps.map((s) => s.parentToolUseId)).toEqual(['tu_agent', 'tu_agent'])
    expect(r.finalText).toBeUndefined()
  })

  it('stamps a subagent tool_result with parent_tool_use_id', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'user',
        parent_tool_use_id: 'tu_agent',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'tu_inner', content: 'ok' }],
        },
      }),
      AT,
    )
    expect(r.steps[0].parentToolUseId).toBe('tu_agent')
  })

  it('leaves parentToolUseId undefined and sets finalText for the main agent', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: 'msg_main', content: [{ type: 'text', text: 'reply' }] },
      }),
      AT,
    )
    expect(r.steps[0].parentToolUseId).toBeUndefined()
    expect(r.finalText).toBe('reply')
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

  it('pulls token usage from a result event without deriving a model', () => {
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
        // modelUsage is present but ignored: the reducer no longer picks a
        // busiest model. The caller stamps the session's driving model instead.
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
      model: undefined,
    })
    // A result event's total is authoritative — it replaces the running estimate.
    expect(r.usageFinal).toBe(true)
    expect(r.usageInferenceId).toBeUndefined()
  })

  it('pulls the turn dollar cost from a result event total_cost_usd', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'result',
        result: 'done',
        usage: { output_tokens: 5 },
        total_cost_usd: 0.4728,
      }),
      AT,
    )
    expect(r.usage?.costUsd).toBe(0.4728)
  })

  it('leaves costUsd undefined when a result event omits total_cost_usd', () => {
    const r = reduceStreamLine(
      JSON.stringify({ type: 'result', result: 'done', usage: { output_tokens: 5 } }),
      AT,
    )
    expect(r.usage?.costUsd).toBeUndefined()
  })

  it('pulls per-inference usage and id from an assistant event', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_abc',
          model: 'claude-opus-4-8',
          content: [{ type: 'text', text: 'hi' }],
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 8000,
            cache_creation_input_tokens: 200,
          },
        },
      }),
      AT,
    )
    expect(r.usage).toEqual({
      input: 12,
      output: 3,
      cacheRead: 8000,
      cacheCreation: 200,
      model: 'claude-opus-4-8',
    })
    // Tagged with the inference id so the reducer counts it once, and not final.
    expect(r.usageInferenceId).toBe('msg_abc')
    expect(r.usageFinal).toBeUndefined()
  })

  it('pulls the cache-miss diagnostic from a main-agent assistant event', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_abc',
          model: 'claude-opus-4-8',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 2, output_tokens: 3 },
          diagnostics: {
            cache_miss_reason: {
              type: 'system_changed',
              cache_missed_input_tokens: 48815,
            },
          },
        },
      }),
      AT,
    )
    expect(r.usage?.cacheMiss).toEqual({
      reason: 'system_changed',
      missedTokens: 48815,
    })
  })

  it('ignores a subagent inference cache-miss diagnostic', () => {
    // A subagent runs its own (fresh) prompt, so its first inference always
    // misses — recording it would drown out the session's own signal.
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'toolu_parent',
        message: {
          id: 'msg_sub',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 2, output_tokens: 3 },
          diagnostics: {
            cache_miss_reason: { type: 'new_prompt', cache_missed_input_tokens: 9 },
          },
        },
      }),
      AT,
    )
    expect(r.usage?.cacheMiss).toBeUndefined()
  })

  it('leaves cacheMiss absent when the event carries no diagnostics', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_abc',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 2, output_tokens: 3 },
        },
      }),
      AT,
    )
    expect(r.usage?.cacheMiss).toBeUndefined()
  })

  it('reports the driving model from a system/init event', () => {
    const r = reduceStreamLine(
      JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-4-8' }),
      AT,
    )
    expect(r.drivingModel).toBe('claude-opus-4-8')
    expect(r.steps).toEqual([])
  })

  it('omits drivingModel for a non-init system event or a missing model', () => {
    expect(
      reduceStreamLine(JSON.stringify({ type: 'system', subtype: 'task_progress' }), AT)
        .drivingModel,
    ).toBeUndefined()
    expect(
      reduceStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }), AT).drivingModel,
    ).toBeUndefined()
  })

  it('leaves usage undefined when an assistant event carries none', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'msg_abc', content: [{ type: 'text', text: 'hi' }] },
      }),
      AT,
    )
    expect(r.usage).toBeUndefined()
    expect(r.usageInferenceId).toBeUndefined()
  })

  it('reports a rejecting rate_limit_event reset time as ISO', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          resetsAt: 1782336600,
          rateLimitType: 'five_hour',
        },
      }),
      AT,
    )
    // resetsAt is epoch *seconds*; 1782336600 → 2026-06-24T21:30:00Z.
    expect(r.rateLimitResetsAt).toBe('2026-06-24T21:30:00.000Z')
    expect(r.steps).toEqual([])
  })

  it('omits the reset time for a non-rejecting rate_limit_event', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', resetsAt: 1782336600 },
      }),
      AT,
    )
    expect(r.rateLimitResetsAt).toBeUndefined()
  })

  it('omits the reset time when a rejection carries no resetsAt', () => {
    const r = reduceStreamLine(
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected' },
      }),
      AT,
    )
    expect(r.rateLimitResetsAt).toBeUndefined()
  })
})

describe('addUsage', () => {
  const u = (input: number, output: number, cacheRead = 0, cacheCreation = 0, model?: string) => ({
    input,
    output,
    cacheRead,
    cacheCreation,
    model,
  })

  it('returns the first snapshot unchanged when there is no accumulator', () => {
    expect(addUsage(undefined, u(10, 2, 5, 1, 'opus'))).toEqual(u(10, 2, 5, 1, 'opus'))
  })

  it('sums token counts and takes the latest model', () => {
    expect(addUsage(u(10, 2, 5, 1, 'opus'), u(3, 4, 6, 2, 'haiku'))).toEqual(
      u(13, 6, 11, 3, 'haiku'),
    )
  })

  it('keeps the prior model when the new snapshot has none', () => {
    expect(addUsage(u(10, 2, 5, 1, 'opus'), u(3, 4, 6, 2)).model).toBe('opus')
  })

  it('leaves cost undefined while no snapshot carries one, then sums it', () => {
    // Per-inference snapshots have no cost (only the result event does), so a
    // turn mid-stream reports no cost rather than a misleading zero.
    expect(addUsage(u(10, 2), u(3, 4)).costUsd).toBeUndefined()
    expect(addUsage({ ...u(10, 2), costUsd: 0.1 }, { ...u(3, 4), costUsd: 0.4 }).costUsd).toBe(
      0.5,
    )
    expect(addUsage(u(10, 2), { ...u(3, 4), costUsd: 0.4 }).costUsd).toBe(0.4)
  })

  it('keeps the first cache miss across later snapshots', () => {
    const miss = { reason: 'system_changed', missedTokens: 100 }
    const later = { reason: 'tools_changed', missedTokens: 5 }
    // The turn-start miss is the story; a later inference's can't displace it.
    expect(
      addUsage({ ...u(10, 2), cacheMiss: miss }, { ...u(3, 4), cacheMiss: later })
        .cacheMiss,
    ).toEqual(miss)
    // …but a first miss arriving mid-turn is still recorded.
    expect(addUsage(u(10, 2), { ...u(3, 4), cacheMiss: later }).cacheMiss).toEqual(
      later,
    )
    expect(addUsage(u(10, 2), u(3, 4)).cacheMiss).toBeUndefined()
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
