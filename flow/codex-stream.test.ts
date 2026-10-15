import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  codexTurnUsage,
  extractCodexSession,
  readThreadUsage,
  reduceCodexStreamLine,
  unwrapShellCommand,
} from './codex-stream'

const AT = '2026-01-01T00:00:00.000Z'
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/fixtures/codex')

function fixtureLines(name: string): string[] {
  return readFileSync(path.join(FIXTURES, name), 'utf8').trim().split('\n')
}

function reduceFixture(name: string) {
  const lines = fixtureLines(name)
  const updates = lines.map((line) => reduceCodexStreamLine(line, AT))
  return {
    lines,
    updates,
    steps: updates.flatMap((u) => u.steps),
    finalText: lastDefined(updates.map((u) => u.finalText)),
    threadUsage: lastDefined(updates.map((u) => u.threadUsage)),
    terminalErrors: updates
      .map((u) => u.terminalError)
      .filter((e): e is string => typeof e === 'string'),
    blockedIds: updates.flatMap((u) => u.blockedIds ?? []),
  }
}

function lastDefined<T>(values: (T | undefined)[]): T | undefined {
  return values.filter((v): v is T => v !== undefined).at(-1)
}

describe('Codex stream reducer', () => {
  it('returns no steps for invalid JSON', () => {
    expect(reduceCodexStreamLine('not json', AT)).toEqual({ steps: [] })
  })

  it('extracts Codex thread ids as provider session ids', () => {
    const [line] = fixtureLines('text-only-success.jsonl')
    expect(extractCodexSession(line)).toBe(
      '019f0000-0000-7000-8000-000000000001',
    )
    expect(extractCodexSession(JSON.stringify({ type: 'turn.started' }))).toBeUndefined()
  })

  it('reduces a text-only successful turn and the thread total', () => {
    const r = reduceFixture('text-only-success.jsonl')
    expect(r.steps).toEqual([
      {
        kind: 'text',
        text: 'codex-fixture-ok',
        createdAt: AT,
      },
    ])
    expect(r.finalText).toBe('codex-fixture-ok')
    expect(r.threadUsage).toEqual({
      input: 1886,
      output: 33,
      cacheRead: 10112,
      cacheCreation: 0,
    })
  })

  // The two fixtures are consecutive turns of one thread, and the resumed one's
  // turn.completed carries the thread's running total (11,998 → 24,388 input).
  it('charges a resumed turn only its difference from the previous total', () => {
    const first = reduceFixture('text-only-success.jsonl').threadUsage!
    const resumed = reduceFixture('resumed-session.jsonl').threadUsage!
    expect(resumed.input + resumed.cacheRead).toBe(24388)
    expect(codexTurnUsage(resumed, first)).toEqual({
      input: 742, // (24,388 − 21,760) − (11,998 − 10,112)
      output: 27,
      cacheRead: 11648,
      cacheCreation: 0,
    })
  })

  it('charges a fresh thread its whole total', () => {
    const first = reduceFixture('text-only-success.jsonl').threadUsage!
    const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
    expect(codexTurnUsage(first, zero)).toEqual(first)
  })

  it('takes the whole total when it went down, as a restarted count', () => {
    const first = reduceFixture('text-only-success.jsonl').threadUsage!
    const resumed = reduceFixture('resumed-session.jsonl').threadUsage!
    expect(codexTurnUsage(first, resumed)).toEqual(first)
  })

  it('leaves the turn uncharged when there is no previous total', () => {
    const resumed = reduceFixture('resumed-session.jsonl').threadUsage!
    expect(codexTurnUsage(resumed, undefined)).toBeUndefined()
  })

  it('reads back only a well-formed saved total', () => {
    const first = reduceFixture('text-only-success.jsonl').threadUsage!
    expect(readThreadUsage(JSON.parse(JSON.stringify(first)))).toEqual(first)
    expect(readThreadUsage(undefined)).toBeUndefined()
    expect(readThreadUsage({ input: 1, output: 2 })).toBeUndefined()
  })

  it('reduces command executions using Codex\'s reported tool name', () => {
    const r = reduceFixture('command-execution.jsonl')
    expect(r.steps).toEqual([
      {
        kind: 'tool_use',
        tool: 'command_execution',
        input: 'printf codex-command-fixture',
        toolUseId: 'item_0',
        rule: "command_execution(/bin/zsh -lc 'printf codex-command-fixture')",
        createdAt: AT,
      },
      {
        kind: 'tool_result',
        text: 'codex-command-fixture',
        toolUseId: 'item_0',
        isError: false,
        createdAt: AT,
      },
      {
        kind: 'text',
        text: 'done',
        createdAt: AT,
      },
    ])
    expect(r.finalText).toBe('done')
  })

  it('carries inputFull for a multi-line command, omitting it for short single-line ones', () => {
    const multi = reduceCodexStreamLine(
      JSON.stringify({
        type: 'item.started',
        item: { type: 'command_execution', id: 'item_0', command: 'echo one\necho two' },
      }),
      AT,
    )
    expect(multi.steps[0]).toEqual({
      kind: 'tool_use',
      tool: 'command_execution',
      input: 'echo one\necho two',
      inputFull: 'echo one\necho two',
      toolUseId: 'item_0',
      rule: 'command_execution(echo one\necho two)',
      createdAt: AT,
    })
    const short = reduceCodexStreamLine(
      JSON.stringify({
        type: 'item.started',
        item: { type: 'command_execution', id: 'item_1', command: 'ls' },
      }),
      AT,
    )
    expect(short.steps[0].inputFull).toBeUndefined()
  })

  it('marks failed command executions without treating them as permission blocks', () => {
    const r = reduceFixture('failed-command.jsonl')
    expect(r.steps[1]).toEqual({
      kind: 'tool_result',
      text: 'codex-failed-command',
      toolUseId: 'item_0',
      isError: true,
      createdAt: AT,
    })
    expect(r.blockedIds).toEqual([])
    expect(r.finalText).toContain('Command failed with exit code `7`')
  })

  it('reduces file changes using Codex\'s reported tool name without inventing edit hunks', () => {
    const r = reduceFixture('file-change.jsonl')
    expect(r.steps).toEqual([
      {
        kind: 'tool_use',
        tool: 'file_change',
        input: 'add /repo/codex_patch_fixture.txt',
        toolUseId: 'item_0',
        rule: 'file_change(/repo/codex_patch_fixture.txt)',
        createdAt: AT,
      },
      {
        kind: 'tool_result',
        text: '',
        toolUseId: 'item_0',
        isError: false,
        createdAt: AT,
      },
      {
        kind: 'text',
        text: 'done',
        createdAt: AT,
      },
    ])
  })

  it('settles a file change that Codex reports failed as an error', () => {
    const r = reduceCodexStreamLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'file_change', changes: [], status: 'failed' },
      }),
      AT,
    )
    expect(r.steps).toEqual([
      { kind: 'tool_result', text: '', toolUseId: 'item_0', isError: true, createdAt: AT },
    ])
  })

  // Captured from codex-cli 0.154.0. Every item lands between the messages the
  // agent wrote before and after it, in stream order.
  it('reduces web searches, MCP calls and file changes in stream order', () => {
    const r = reduceFixture('tool-coverage.jsonl')
    expect(
      r.steps.map((s) =>
        s.kind === 'text'
          ? `text: ${s.text!.split('\n')[0]}`
          : s.kind === 'tool_use'
            ? `use ${s.tool}(${s.input}) #${s.toolUseId}`
            : `result #${s.toolUseId}${s.isError ? ' error' : ''}: ${s.text}`,
      ),
    ).toEqual([
      'text: No plan/todo tool is available, so I’ll track the three items here:',
      'use web_search(codex cli exec json events) #exec-c92104ec-c27a-4b4d-a418-f176a15c607a',
      'result #exec-c92104ec-c27a-4b4d-a418-f176a15c607a: ',
      'text: 1. Web search — complete.',
      'use mcp_tool_call(playwright browser_navigate: https://example.com) #item_5',
      'result #item_5 error: MCP tool call requires approval, but approval policy is never',
      'text: Navigation was blocked because the tool requires approval and this session’s approval policy is `never`.',
      'use file_change(add /tmp/codex-probe/hello.txt) #item_7',
      'result #item_7: ',
      'text: 3. Both patch attempts — complete: created `hello.txt` containing `hi`; modifying `missing.txt` failed as expected.',
      'text: done',
    ])
  })

  it('folds an MCP result from its content blocks', () => {
    const r = reduceCodexStreamLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'mcp_tool_call',
          server: 's',
          tool: 't',
          arguments: {},
          result: { content: [{ type: 'text', text: 'page loaded' }] },
          error: null,
          status: 'completed',
        },
      }),
      AT,
    )
    expect(r.steps).toEqual([
      { kind: 'tool_result', text: 'page loaded', toolUseId: 'item_0', isError: false, createdAt: AT },
    ])
  })

  // Codex 0.154 emits no item for spawn_agent; its waits are the only trace of
  // subagents in the public stream.
  it('reduces multi-agent waits between the prose around them', () => {
    const r = reduceFixture('collab-wait.jsonl')
    expect(
      r.steps.map((s) =>
        s.kind === 'text'
          ? `text: ${s.text!.trim()}`
          : s.kind === 'tool_use'
            ? `use ${s.tool}(${s.input}) #${s.toolUseId}`
            : `result #${s.toolUseId}${s.isError ? ' error' : ''}: ${s.text}`,
      ),
    ).toEqual([
      'text: I’ll start both subagents in parallel and wait for their results.',
      'use collab_tool_call(wait) #item_1',
      'result #item_1: ',
      'use collab_tool_call(wait) #item_2',
      'result #item_2: ',
      'text: Subagent A: slept; Subagent B: beta',
    ])
  })

  // Not observed from 0.154 — its spawns bypass this item — but the schema
  // carries them, so they read through when Codex fills them in.
  it('shows a multi-agent call’s prompt and its agents’ closing states', () => {
    const [use] = reduceCodexStreamLine(
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_0',
          type: 'collab_tool_call',
          tool: 'spawn_agent',
          sender_thread_id: 't0',
          receiver_thread_ids: [],
          prompt: 'count the files',
          agents_states: {},
          status: 'in_progress',
        },
      }),
      AT,
    ).steps
    expect(use).toMatchObject({ tool: 'collab_tool_call', input: 'spawn_agent: count the files' })
    const [result] = reduceCodexStreamLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'collab_tool_call',
          tool: 'wait',
          sender_thread_id: 't0',
          receiver_thread_ids: ['t1'],
          prompt: null,
          agents_states: { t1: { status: 'completed', message: '42 files' } },
          status: 'completed',
        },
      }),
      AT,
    ).steps
    expect(result).toMatchObject({ text: 'completed: 42 files', isError: false })
  })

  // Captured from codex-cli 0.154.0 with a deprecated feature flag: the notice
  // arrives before the turn starts, and is not the model's output.
  it('shows a Codex notice as an error chip carrying its message', () => {
    const r = reduceFixture('error-item.jsonl')
    expect(r.steps.slice(0, 2)).toEqual([
      {
        kind: 'tool_use',
        tool: 'error',
        input:
          '`[features].web_search_request` is deprecated because web search is enabled by default. (Set `web_search` to `"live"`, `"indexed"`, `"cached"`, or `"disabled"` at the top level (or under a profile) in…',
        inputFull:
          '`[features].web_search_request` is deprecated because web search is enabled by default. (Set `web_search` to `"live"`, `"indexed"`, `"cached"`, or `"disabled"` at the top level (or under a profile) in config.toml if you want to override it.)',
        toolUseId: 'item_0',
        createdAt: AT,
      },
      { kind: 'tool_result', text: '', toolUseId: 'item_0', isError: true, createdAt: AT },
    ])
    expect(r.updates[1].notice).toBe(true)
    expect(r.updates[3].notice).toBeUndefined()
    expect(r.finalText).toBe('ok')
  })

  // Codex reports a command whose approval was refused as `declined`, exit -1.
  it('marks a declined command failed', () => {
    const r = reduceCodexStreamLine(
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: 'touch x',
          aggregated_output: 'rejected by user',
          exit_code: -1,
          status: 'declined',
        },
      }),
      AT,
    )
    expect(r.steps[0]).toMatchObject({ kind: 'tool_result', isError: true })
  })

  it('names the page for web actions other than a search', () => {
    const input = (action: unknown) =>
      reduceCodexStreamLine(
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'ws', type: 'web_search', query: '', action },
        }),
        AT,
      ).steps[0].input
    expect(input({ type: 'search', queries: ['a', 'b'] })).toBe('a, b')
    expect(input({ type: 'open_page', url: 'https://x.test' })).toBe('open_page https://x.test')
    expect(input({ type: 'find_in_page', url: 'https://x.test', pattern: 'foo' })).toBe(
      'find_in_page https://x.test foo',
    )
  })

  it('lists every path a file change touches', () => {
    const [use] = reduceCodexStreamLine(
      JSON.stringify({
        type: 'item.started',
        item: {
          id: 'fc',
          type: 'file_change',
          changes: [
            { path: '/r/a.ts', kind: 'update' },
            { path: '/r/b.ts', kind: 'add' },
          ],
          status: 'in_progress',
        },
      }),
      AT,
    ).steps
    expect(use.input).toBe('update /r/a.ts, add /r/b.ts')
  })

  it('unwraps the login-shell wrapper Codex puts around every command', () => {
    expect(unwrapShellCommand("/bin/zsh -lc 'git log --oneline -3'")).toBe(
      'git log --oneline -3',
    )
    expect(unwrapShellCommand(`/bin/zsh -lc 'echo '"'"'hi'"'"''`)).toBe(
      "echo 'hi'",
    )
    // Captured: a double-quoted heredoc whose body carries escaped quotes.
    expect(
      unwrapShellCommand(
        `/bin/zsh -lc "python3 - <<'PY'\nprint(\\"a \\$b\\")\nPY"`,
      ),
    ).toBe(`python3 - <<'PY'\nprint("a $b")\nPY`)
    expect(unwrapShellCommand('/bin/bash -lc ls')).toBe('ls')
    // Anything else reads as Codex sent it.
    expect(unwrapShellCommand('ls -la')).toBe('ls -la')
    expect(unwrapShellCommand("/bin/zsh -lc 'unterminated")).toBe(
      "/bin/zsh -lc 'unterminated",
    )
    expect(unwrapShellCommand("/bin/zsh -lc 'a' 'b'")).toBe(
      "/bin/zsh -lc 'a' 'b'",
    )
  })

  it('surfaces top-level error and turn.failed events as terminal errors', () => {
    const r = reduceFixture('turn-failed.jsonl')
    // The fixture's one item is a notice, not the model's work.
    expect(r.steps.map((s) => `${s.kind} ${s.tool ?? ''}`)).toEqual([
      'tool_use error',
      'tool_result ',
    ])
    expect(r.updates.filter((u) => u.steps.length).every((u) => u.notice)).toBe(true)
    expect([...new Set(r.terminalErrors)]).toEqual([
      "The 'definitely-not-a-real-model' model is not supported when using Codex with a ChatGPT account.",
    ])
  })

  it('marks only turn.started as the turn starting, ahead of a failure', () => {
    const r = reduceFixture('turn-failed.jsonl')
    expect(r.updates.map((u) => u.turnStarted === true)).toEqual([
      false,
      false,
      true,
      false,
      false,
    ])
  })

  it('extracts the same session id from resumed sessions', () => {
    const r = reduceFixture('resumed-session.jsonl')
    expect(extractCodexSession(r.lines[0])).toBe(
      '019f0000-0000-7000-8000-000000000001',
    )
    expect(r.finalText).toBe('codex-resume-ok')
  })

  it('does not invent blocked tool ids for sandbox denial prose', () => {
    const r = reduceFixture('sandbox-denial-message.jsonl')
    expect(r.finalText).toContain('workspace is read-only')
    expect(r.blockedIds).toEqual([])
    expect(r.terminalErrors).toEqual([])
  })
})
