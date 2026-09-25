import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  codexTurnUsage,
  extractCodexSession,
  readThreadUsage,
  reduceCodexStreamLine,
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
        input: "/bin/zsh -lc 'printf codex-command-fixture'",
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
        kind: 'text',
        text: 'done',
        createdAt: AT,
      },
    ])
  })

  it('surfaces top-level error and turn.failed events as terminal errors', () => {
    const r = reduceFixture('turn-failed.jsonl')
    expect(r.steps).toEqual([])
    expect([...new Set(r.terminalErrors)]).toEqual([
      "The 'definitely-not-a-real-model' model is not supported when using Codex with a ChatGPT account.",
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
