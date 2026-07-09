import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  codexOptionsFromEnv,
  createCodexAdapter,
  extractCodexSession,
  reduceCodexStreamLine,
} from './codex'

const AT = '2026-01-01T00:00:00.000Z'
const FIXTURES = path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server'),
  'fixtures',
  'codex',
)

const TASK_PROMPT_TEMPLATE = 'Task prompt: {{forwardable}}.'
const adapter = createCodexAdapter({
  taskPromptTemplate: TASK_PROMPT_TEMPLATE,
})

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

function managedPrompt(prompt: string, forwardable: string): string {
  return `Task prompt: ${forwardable}.\n\n${prompt}`
}

describe('Codex adapter reducer', () => {
  it('exposes Codex adapter capabilities', () => {
    expect(adapter.kind).toBe('codex')
    expect(adapter.command).toBe('codex')
    expect(adapter.supportsProjectGrants).toBe(false)
    expect(adapter.supportsWorktreeFlag).toBe(false)
    expect(adapter.supportsUsageSnapshot).toBe(false)
    expect(adapter.supportsRateLimitRetryScheduling).toBe(false)
  })

  it('builds first-turn Codex exec args with conservative sandboxing', () => {
    const launch = adapter.buildLaunch({
      task: {
        allowEdits: false,
      },
      prompt: 'hello codex',
      root: '/repo',
      cwd: '/repo/subdir',
      landerEnv: {
        PATH: '/repo/bin:/usr/bin',
        LANDER_API: 'http://localhost:6181',
        LANDER_PROJECT: 'proj',
        LANDER_TASK: 'task-1',
        LANDER_TOKEN: 'secret-token',
      },
    })

    expect(launch.env).toEqual({
      PATH: '/repo/bin:/usr/bin',
      LANDER_API: 'http://localhost:6181',
      LANDER_PROJECT: 'proj',
      LANDER_TASK: 'task-1',
      LANDER_TOKEN: 'secret-token',
    })
    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--config',
      'sandbox_workspace_write.network_access=true',
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--cd',
      '/repo/subdir',
      '--sandbox',
      'read-only',
      managedPrompt(
        'hello codex',
        'This Codex turn runs with the read-only sandbox. Task allow rules are stored by Lander but do not affect Codex runs yet',
      ),
    ])
    expect(launch.args.join('\0')).not.toContain('secret-token')
    expect(launch.args).not.toContain('--skip-git-repo-check')
  })

  it('maps editable first-turn Codex tasks to workspace-write', () => {
    const launch = adapter.buildLaunch({
      task: {
        allowEdits: true,
      },
      prompt: 'edit files',
      root: '/repo',
      cwd: '/repo',
      landerEnv: {},
    })

    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--config',
      'sandbox_workspace_write.network_access=true',
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--cd',
      '/repo',
      '--sandbox',
      'workspace-write',
      managedPrompt(
        'edit files',
        'This Codex turn runs with the workspace-write sandbox for file edits. Task allow rules are stored by Lander but do not affect Codex runs yet',
      ),
    ])
  })

  it('builds Codex resume args from the provider session id', () => {
    const launch = adapter.buildLaunch({
      task: {
        sessionId: '019f0000-0000-7000-8000-000000000001',
        allowEdits: false,
      },
      prompt: 'follow up',
      root: '/repo',
      cwd: '/repo/subdir',
      landerEnv: { LANDER_TASK: 'task-1' },
    })

    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--config',
      'sandbox_workspace_write.network_access=true',
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--config',
      'sandbox_mode="read-only"',
      '--cd',
      '/repo/subdir',
      'resume',
      '019f0000-0000-7000-8000-000000000001',
      managedPrompt(
        'follow up',
        'This Codex turn runs with the read-only sandbox. Task allow rules are stored by Lander but do not affect Codex runs yet',
      ),
    ])
  })

  it('maps editable Codex resume tasks to workspace-write config', () => {
    const launch = adapter.buildLaunch({
      task: {
        sessionId: '019f0000-0000-7000-8000-000000000001',
        allowEdits: true,
      },
      prompt: 'follow up with edits',
      root: '/repo',
      cwd: '/repo',
      landerEnv: {},
    })

    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--config',
      'sandbox_workspace_write.network_access=true',
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--config',
      'sandbox_mode="workspace-write"',
      '--cd',
      '/repo',
      'resume',
      '019f0000-0000-7000-8000-000000000001',
      managedPrompt(
        'follow up with edits',
        'This Codex turn runs with the workspace-write sandbox for file edits. Task allow rules are stored by Lander but do not affect Codex runs yet',
      ),
    ])
  })

  it('adds optional Codex profile and config flags before resume', () => {
    const configured = createCodexAdapter({
      taskPromptTemplate: TASK_PROMPT_TEMPLATE,
      profile: 'lander-codex',
      configOverrides: ['model="gpt-5-codex"', 'approval_policy="never"'],
    })
    const launch = configured.buildLaunch({
      task: {
        sessionId: '019f0000-0000-7000-8000-000000000001',
        allowEdits: true,
      },
      prompt: 'configured follow up',
      root: '/repo',
      cwd: '/repo/subdir',
      landerEnv: { LANDER_TASK: 'task-1' },
    })

    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--profile',
      'lander-codex',
      '--config',
      'model="gpt-5-codex"',
      '--config',
      'approval_policy="never"',
      '--config',
      'sandbox_workspace_write.network_access=true',
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--config',
      'sandbox_mode="workspace-write"',
      '--cd',
      '/repo/subdir',
      'resume',
      '019f0000-0000-7000-8000-000000000001',
      managedPrompt(
        'configured follow up',
        'This Codex turn runs with the workspace-write sandbox for file edits. Task allow rules are stored by Lander but do not affect Codex runs yet',
      ),
    ])
  })

  it('adds optional Codex profile and config flags before per-run env config', () => {
    const configured = createCodexAdapter({
      taskPromptTemplate: TASK_PROMPT_TEMPLATE,
      profile: 'lander-codex',
      configOverrides: ['model="gpt-5-codex"', 'approval_policy="never"'],
    })
    const launch = configured.buildLaunch({
      task: {
        allowEdits: true,
      },
      prompt: 'use configured codex',
      root: '/repo',
      cwd: '/repo',
      landerEnv: { LANDER_TASK: 'task-1' },
    })

    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--profile',
      'lander-codex',
      '--config',
      'model="gpt-5-codex"',
      '--config',
      'approval_policy="never"',
      '--config',
      'sandbox_workspace_write.network_access=true',
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--cd',
      '/repo',
      '--sandbox',
      'workspace-write',
      managedPrompt(
        'use configured codex',
        'This Codex turn runs with the workspace-write sandbox for file edits. Task allow rules are stored by Lander but do not affect Codex runs yet',
      ),
    ])
  })

  it('parses optional Codex profile and config overrides from env', () => {
    expect(
      codexOptionsFromEnv({
        LANDER_CODEX_PROFILE: ' lander-codex ',
        LANDER_CODEX_CONFIG: '\nmodel="gpt-5-codex"\n approval_policy="never" \n',
      }),
    ).toEqual({
      profile: 'lander-codex',
      configOverrides: ['model="gpt-5-codex"', 'approval_policy="never"'],
    })
    expect(codexOptionsFromEnv({ LANDER_CODEX_PROFILE: ' ', LANDER_CODEX_CONFIG: '\n' })).toEqual(
      {},
    )
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
