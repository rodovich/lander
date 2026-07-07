import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createCodexAdapter,
  extractCodexSession,
  reduceCodexStreamLine,
} from './codex'

const AT = '2026-01-01T00:00:00.000Z'
const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'codex',
)

const adapter = createCodexAdapter()

function fixtureLines(name: string): string[] {
  return readFileSync(path.join(FIXTURES, name), 'utf8').trim().split('\n')
}

function reduceFixture(name: string) {
  const lines = fixtureLines(name)
  const updates = lines.map((line) => adapter.reduceLine(line, AT))
  return {
    lines,
    updates,
    steps: updates.flatMap((u) => u.steps),
    finalText: lastDefined(updates.map((u) => u.finalText)),
    usage: lastDefined(updates.map((u) => u.usage)),
    usageFinal: lastDefined(updates.map((u) => u.usageFinal)),
    terminalErrors: updates
      .map((u) => u.terminalError)
      .filter((e): e is string => typeof e === 'string'),
    blockedIds: updates.flatMap((u) => u.blockedIds ?? []),
  }
}

function lastDefined<T>(values: (T | undefined)[]): T | undefined {
  return values.filter((v): v is T => v !== undefined).at(-1)
}

describe('Codex adapter reducer', () => {
  it('exposes Codex adapter capabilities', () => {
    expect(adapter.kind).toBe('codex')
    expect(adapter.command).toBe('codex')
    expect(adapter.hookStrategy).toBe('project-config')
    expect(adapter.supportsProjectGrants).toBe(false)
    expect(adapter.supportsWorktreeFlag).toBe(false)
    expect(adapter.supportsUsageSnapshot).toBe(false)
  })

  it('builds first-turn Codex exec args with conservative sandboxing', () => {
    const launch = adapter.buildLaunch({
      task: {
        allowEdits: false,
        allowCommits: true,
      },
      prompt: 'hello codex',
      root: '/repo',
      cwd: '/repo/subdir',
      landerEnv: { LANDER_TASK: 'task-1' },
    })

    expect(launch.command).toBe('codex')
    expect(launch.env).toEqual({ LANDER_TASK: 'task-1' })
    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--cd',
      '/repo/subdir',
      '--sandbox',
      'read-only',
      'hello codex',
    ])
    expect(launch.args).not.toContain('--skip-git-repo-check')
  })

  it('maps editable first-turn Codex tasks to workspace-write', () => {
    const launch = adapter.buildLaunch({
      task: {
        allowEdits: true,
        allowCommits: true,
      },
      prompt: 'edit files',
      root: '/repo',
      cwd: '/repo',
      landerEnv: {},
    })

    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--cd',
      '/repo',
      '--sandbox',
      'workspace-write',
      'edit files',
    ])
  })

  it('builds Codex resume args from the provider session id', () => {
    const launch = adapter.buildLaunch({
      task: {
        sessionId: '019f0000-0000-7000-8000-000000000001',
        allowEdits: false,
        allowCommits: false,
      },
      prompt: 'follow up',
      root: '/repo',
      cwd: '/repo',
      landerEnv: { LANDER_TASK: 'task-1' },
    })

    expect(launch.args).toEqual([
      'exec',
      'resume',
      '--json',
      '019f0000-0000-7000-8000-000000000001',
      'follow up',
    ])
  })

  it('does not pre-mint Codex sessions in the daemon session prelude', () => {
    expect(
      adapter.buildSession({
        sessionId: 'existing-thread',
        mintSessionId: () => 'minted',
      }),
    ).toEqual({
      args: [],
      announceSession: false,
    })

    expect(
      adapter.buildSession({
        mintSessionId: () => 'minted',
      }),
    ).toEqual({
      args: [],
      announceSession: false,
    })
  })

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

  it('reduces a text-only successful turn and final usage', () => {
    const r = reduceFixture('text-only-success.jsonl')
    expect(r.steps).toEqual([
      {
        kind: 'text',
        text: 'codex-fixture-ok',
        createdAt: AT,
      },
    ])
    expect(r.finalText).toBe('codex-fixture-ok')
    expect(r.usage).toEqual({
      input: 1886,
      output: 33,
      cacheRead: 10112,
      cacheCreation: 0,
    })
    expect(r.usageFinal).toBe(true)
  })

  it('reduces command executions into Bash tool use and result steps', () => {
    const r = reduceFixture('command-execution.jsonl')
    expect(r.steps).toEqual([
      {
        kind: 'tool_use',
        tool: 'Bash',
        input: "/bin/zsh -lc 'printf codex-command-fixture'",
        toolUseId: 'item_0',
        rule: "Bash(/bin/zsh -lc 'printf codex-command-fixture')",
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

  it('reduces file changes into a tool use step without inventing edit hunks', () => {
    const r = reduceFixture('file-change.jsonl')
    expect(r.steps).toEqual([
      {
        kind: 'tool_use',
        tool: 'FileChange',
        input: 'add /repo/codex_patch_fixture.txt',
        toolUseId: 'item_0',
        rule: 'FileChange(/repo/codex_patch_fixture.txt)',
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
    expect(adapter.extractSession?.(r.lines[0])).toBe(
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
