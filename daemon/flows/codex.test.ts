import { describe, expect, it } from 'vitest'
import { makeFlow, resolveLaunchDir, codexOptionsFromEnv, type CodexFlowDeps } from './codex'
import { captureDriverTurn, type DriverTurnFixture } from './testCtx'

const TASK_PROMPT_TEMPLATE = 'Task prompt: {{forwardable}}.'
function runCodex(input: DriverTurnFixture, overrides: Partial<CodexFlowDeps> = {}) {
  return captureDriverTurn(makeFlow({
    taskPromptTemplate: TASK_PROMPT_TEMPLATE,
    readProjectDoc: () => undefined,
    resolveGitCommonDir: () => undefined,
    ...overrides,
  }), input)
}

function permissionArgs(
  allowEdits: boolean,
  projectRoot = '/repo',
  gitCommonDir?: string,
): string[] {
  const profileId = allowEdits ? 'lander-edit' : 'lander-read-only'
  const description = allowEdits
    ? 'Lander workspace edit access'
    : 'Lander workspace read-only access'
  const commonDirRule =
    allowEdits && gitCommonDir ? `,"${gitCommonDir}"="write"` : ''
  const profile = allowEdits
    ? `description="${description}",extends=":workspace",workspace_roots={"${projectRoot}"=true},filesystem={":workspace_roots"={".git"="write"}${commonDirRule}},network={enabled=true,allow_local_binding=true}`
    : `description="${description}",extends=":read-only",network={enabled=true,allow_local_binding=true}`
  return [
    '--config',
    `default_permissions="${profileId}"`,
    '--config',
    `permissions.${profileId}={${profile}}`,
  ]
}

function managedPrompt(prompt: string, forwardable: string): string {
  return `Task prompt: ${forwardable}.\n\n${prompt}`
}

describe('Codex flow launch', () => {
  describe('resolveLaunchDir', () => {
    const yes = () => true

    it('resumes from the recorded cwd when it still exists', async () => {
      expect(
        resolveLaunchDir({
          root: '/repo',
          recordedCwd: '/repo/sub',
          isDir: yes,
        }),
      ).toEqual({ cwd: '/repo/sub', reentryArgs: [] })
    })

    it('falls back to root when the recorded cwd is gone', async () => {
      expect(
        resolveLaunchDir({
          root: '/repo',
          recordedCwd: '/repo/sub',
          isDir: () => false,
        }),
      ).toEqual({ cwd: '/repo', reentryArgs: [] })
    })

    it('falls back to root when the recorded cwd is root or absent', async () => {
      expect(
        resolveLaunchDir({
          root: '/repo',
          recordedCwd: '/repo',
          isDir: yes,
        }),
      ).toEqual({ cwd: '/repo', reentryArgs: [] })
      expect(
        resolveLaunchDir({ root: '/repo', isDir: yes }),
      ).toEqual({ cwd: '/repo', reentryArgs: [] })
    })
  })

  it('builds first-turn Codex exec args with workspace-scoped read access', async () => {
    const launch = await runCodex({
      task: {
        allowEdits: false,
      },
      prompt: 'hello codex',
      root: '/repo',
      cwd: '/repo/subdir',
      env: {
        PATH: '/repo/bin:/usr/bin',
        LANDER_API: 'http://localhost:6181',
        LANDER_PROJECT: 'proj',
        LANDER_TASK: 'task-1',
        LANDER_TOKEN: 'secret-token',
      },
    })

    expect(launch.env).toMatchObject({
      PATH: '/repo/bin:/usr/bin',
      LANDER_API: 'http://localhost:6181',
      LANDER_PROJECT: 'proj',
      LANDER_TASK: 'task-1',
      LANDER_TOKEN: 'secret-token',
    })
    expect(launch.args).toEqual([
      'exec',
      '--json',
      ...permissionArgs(false),
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--cd',
      '/repo/subdir',
      '--',
      managedPrompt(
        'hello codex',
        'As of this message, this task runs with the workspace-scoped read-only permission profile. Task allow rules are stored by Lander but do not affect Codex runs yet',
      ),
    ])
    expect(launch.args.join('\0')).not.toContain('secret-token')
    expect(launch.args).not.toContain('--skip-git-repo-check')
    expect(launch.args).not.toContain('--sandbox')
    expect(launch.args.join('\0')).not.toContain('sandbox_mode')
    expect(launch.args.join('\0')).toContain('extends=":read-only"')
  })

  it('maps editable first-turn Codex tasks to a workspace edit profile', async () => {
    const launch = await runCodex({
      task: {
        allowEdits: true,
      },
      prompt: 'edit files',
      root: '/repo',
      cwd: '/repo',
      env: {},
    })

    expect(launch.args).toEqual([
      'exec',
      '--json',
      ...permissionArgs(true),
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--cd',
      '/repo',
      '--',
      managedPrompt(
        'edit files',
        'As of this message, this task runs with the workspace-scoped edit permission profile. Task allow rules are stored by Lander but do not affect Codex runs yet',
      ),
    ])
    expect(launch.args.join('\0')).toContain('extends=":workspace"')
    expect(launch.args.join('\0')).toContain('":workspace_roots"={".git"="write"}')
  })

  it('grants editable worktrees access to the resolved Git common directory', async () => {
    const options: Partial<CodexFlowDeps> = {
      taskPromptTemplate: TASK_PROMPT_TEMPLATE,
      resolveGitCommonDir: (cwd) => {
        expect(cwd).toBe('/worktrees/feature')
        return '/repo/.git'
      },
    }

    const launch = await runCodex({
      task: { allowEdits: true },
      prompt: 'edit worktree',
      root: '/worktrees/feature',
      cwd: '/worktrees/feature',
      env: {},
    }, options)

    expect(launch.args).toEqual([
      'exec',
      '--json',
      ...permissionArgs(true, '/worktrees/feature', '/repo/.git'),
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--cd',
      '/worktrees/feature',
      '--',
      managedPrompt(
        'edit worktree',
        'As of this message, this task runs with the workspace-scoped edit permission profile. Task allow rules are stored by Lander but do not affect Codex runs yet',
      ),
    ])
  })

  it('builds Codex resume args from the provider session id', async () => {
    const launch = await runCodex({
      task: {
        sessionId: '019f0000-0000-7000-8000-000000000001',
        allowEdits: false,
      },
      prompt: 'follow up',
      root: '/repo',
      cwd: '/repo/subdir',
      env: { LANDER_TASK: 'task-1' },
    })

    expect(launch.args).toEqual([
      'exec',
      '--json',
      ...permissionArgs(false),
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--cd',
      '/repo/subdir',
      'resume',
      '019f0000-0000-7000-8000-000000000001',
      '--',
      managedPrompt(
        'follow up',
        'As of this message, this task runs with the workspace-scoped read-only permission profile. Task allow rules are stored by Lander but do not affect Codex runs yet',
      ),
    ])
  })

  it('maps editable Codex resume tasks to the same workspace edit profile', async () => {
    const launch = await runCodex({
      task: {
        sessionId: '019f0000-0000-7000-8000-000000000001',
        allowEdits: true,
      },
      prompt: 'follow up with edits',
      root: '/repo',
      cwd: '/repo',
      env: {},
    })

    expect(launch.args).toEqual([
      'exec',
      '--json',
      ...permissionArgs(true),
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--cd',
      '/repo',
      'resume',
      '019f0000-0000-7000-8000-000000000001',
      '--',
      managedPrompt(
        'follow up with edits',
        'As of this message, this task runs with the workspace-scoped edit permission profile. Task allow rules are stored by Lander but do not affect Codex runs yet',
      ),
    ])
  })

  it('adds optional Codex profile and config flags before resume', async () => {
    const options: Partial<CodexFlowDeps> = {
      taskPromptTemplate: TASK_PROMPT_TEMPLATE,
      profile: 'lander-codex',
      configOverrides: ['model="gpt-5-codex"', 'approval_policy="never"'],
    }
    const launch = await runCodex({
      task: {
        sessionId: '019f0000-0000-7000-8000-000000000001',
        allowEdits: true,
      },
      prompt: 'configured follow up',
      root: '/repo',
      cwd: '/repo/subdir',
      env: { LANDER_TASK: 'task-1' },
    }, options)

    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--profile',
      'lander-codex',
      '--config',
      'model="gpt-5-codex"',
      '--config',
      'approval_policy="never"',
      ...permissionArgs(true),
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--cd',
      '/repo/subdir',
      'resume',
      '019f0000-0000-7000-8000-000000000001',
      '--',
      managedPrompt(
        'configured follow up',
        'As of this message, this task runs with the workspace-scoped edit permission profile. Task allow rules are stored by Lander but do not affect Codex runs yet',
      ),
    ])
  })

  it('adds optional Codex profile and config flags before per-run env config', async () => {
    const options: Partial<CodexFlowDeps> = {
      taskPromptTemplate: TASK_PROMPT_TEMPLATE,
      profile: 'lander-codex',
      configOverrides: ['model="gpt-5-codex"', 'approval_policy="never"'],
    }
    const launch = await runCodex({
      task: {
        allowEdits: true,
      },
      prompt: 'use configured codex',
      root: '/repo',
      cwd: '/repo',
      env: { LANDER_TASK: 'task-1' },
    }, options)

    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--profile',
      'lander-codex',
      '--config',
      'model="gpt-5-codex"',
      '--config',
      'approval_policy="never"',
      ...permissionArgs(true),
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--cd',
      '/repo',
      '--',
      managedPrompt(
        'use configured codex',
        'As of this message, this task runs with the workspace-scoped edit permission profile. Task allow rules are stored by Lander but do not affect Codex runs yet',
      ),
    ])
  })

  // Codex parses the prompt as a positional, so a prompt whose first character
  // is `-` is read as a flag: `codex exec "- bullet"` errors with "unexpected
  // argument" (v0.144.5), and codex's own tip is to pass it after `--`. The
  // task-management template currently leads every prompt, so no user text can
  // reach argv position 1 — these assertions keep that a property of the argv
  // rather than an accident of what the template happens to start with.
  it('terminates flag parsing before the prompt on a fresh exec', async () => {
    const launch = await runCodex({
      task: { allowEdits: false },
      prompt: '- bullet one\n- bullet two',
      root: '/repo',
      cwd: '/repo',
      env: {},
    })

    expect(launch.args.at(-2)).toBe('--')
    expect(launch.args.at(-1)).toContain('- bullet one')
  })

  it('terminates flag parsing before the prompt on resume', async () => {
    const launch = await runCodex({
      task: {
        sessionId: '019f0000-0000-7000-8000-000000000001',
        allowEdits: false,
      },
      prompt: '--help me',
      root: '/repo',
      cwd: '/repo',
      env: {},
    })

    expect(launch.args.at(-2)).toBe('--')
    expect(launch.args.at(-1)).toContain('--help me')
  })

  // The terminator is what makes image placement uniform: everything past `--`
  // is positional, so the repeatable `-i` flags must precede it. Before the
  // terminator they had to trail the prompt on a fresh exec, because the
  // variadic form would otherwise swallow it.
  it('places image flags before the terminator on a fresh exec', async () => {
    const launch = await runCodex({
      task: { allowEdits: false },
      prompt: 'look at this',
      root: '/repo',
      cwd: '/repo',
      env: {},
      images: ['/files/img1', '/files/img2'],
    })

    expect(launch.args.slice(-6)).toEqual([
      '-i',
      '/files/img1',
      '-i',
      '/files/img2',
      '--',
      launch.args.at(-1),
    ])
  })

  it('parses optional Codex profile and config overrides from env', async () => {
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

  it('does not mint a session before Codex reports its thread', async () => {
    const launch = await runCodex({ task: { allowEdits: false }, root: '/repo', cwd: '/repo' })
    expect(launch.events.filter((e) => e.kind === 'state-patch')).toEqual([])
  })
})
