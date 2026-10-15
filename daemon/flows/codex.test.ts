import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  makeFlow,
  resolveLaunchDir,
  CODEX_EDIT_ACCESS_TEXT,
  codexOptionsFromEnv,
  type CodexFlowDeps,
} from './codex'
import { captureDriverTurn, driveFlow, type DriverTurnFixture } from './testCtx'

const TASK_PROMPT_TEMPLATE = 'Task prompt: {{editAccess}}.'
function codexFlow(overrides: Partial<CodexFlowDeps> = {}) {
  return makeFlow({
    taskPromptTemplate: TASK_PROMPT_TEMPLATE,
    readProjectDoc: () => undefined,
    resolveGitDirs: () => [],
    ...overrides,
  })
}

function runCodex(input: DriverTurnFixture, overrides: Partial<CodexFlowDeps> = {}) {
  return captureDriverTurn(codexFlow(overrides), input)
}

function permissionArgs(
  projectRoot = '/repo',
  gitDirs: string[] = [],
): string[] {
  const commonDirRule = gitDirs.map((dir) => `,"${dir}"="write"`).join('')
  const profile = `description="Lander workspace edit access",extends=":workspace",workspace_roots={"${projectRoot}"=true},filesystem={":workspace_roots"={".git"="write"}${commonDirRule}},network={enabled=true,allow_local_binding=true}`
  return [
    '--config',
    'default_permissions="lander-edit"',
    '--config',
    `permissions.lander-edit={${profile}}`,
  ]
}

function managedPrompt(prompt: string): string {
  return `Task prompt: ${CODEX_EDIT_ACCESS_TEXT}.\n\n${prompt}`
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
      ).toEqual({ cwd: '/repo/sub' })
    })

    it('falls back to root when the recorded cwd is gone', async () => {
      expect(
        resolveLaunchDir({
          root: '/repo',
          recordedCwd: '/repo/sub',
          isDir: () => false,
        }),
      ).toEqual({ cwd: '/repo' })
    })

    it('falls back to root when the recorded cwd is root or absent', async () => {
      expect(
        resolveLaunchDir({
          root: '/repo',
          recordedCwd: '/repo',
          isDir: yes,
        }),
      ).toEqual({ cwd: '/repo' })
      expect(resolveLaunchDir({ root: '/repo', isDir: yes })).toEqual({ cwd: '/repo' })
    })
  })

  it('builds first-turn Codex exec args with the workspace edit profile', async () => {
    const launch = await runCodex({
      task: {},
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
      '--skip-git-repo-check',
      ...permissionArgs(),
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--cd',
      '/repo/subdir',
      '--',
      managedPrompt('hello codex'),
    ])
    expect(launch.args.join('\0')).not.toContain('secret-token')
    expect(launch.args).not.toContain('--sandbox')
    expect(launch.args.join('\0')).not.toContain('sandbox_mode')
    expect(launch.args.join('\0')).toContain('extends=":workspace"')
    expect(launch.args.join('\0')).toContain('":workspace_roots"={".git"="write"}')
  })

  it('makes a lander checkout the whole workspace and tells the agent about it', async () => {
    const wt = '/repo/.worktrees/t1'
    const launch = await runCodex(
      { task: {}, prompt: 'work', root: '/repo', cwd: wt, checkout: wt },
      {
        resolveGitDirs: (cwd) => {
          expect(cwd).toBe(wt)
          return ['/repo/.git', '/repo/.git/worktrees/t1']
        },
      },
    )
    const joined = launch.args.join('\0')
    expect(joined).toContain(
      permissionArgs(wt, ['/repo/.git', '/repo/.git/worktrees/t1'])[3],
    )
    expect(joined).not.toContain('workspace_roots={"/repo"=true}')
    expect(launch.args.slice(-4, -2)).toEqual(['--cd', wt])
    expect(launch.args.at(-1)).toContain(
      'This task works in a git worktree lander created for it at `/repo/.worktrees/t1`',
    )

    const outside = await runCodex({
      task: {},
      prompt: 'work',
      root: '/repo',
      cwd: '/repo',
    })
    expect(outside.args.at(-1)).not.toContain('git worktree lander created')
  })

  it('resolves a linked worktree’s own git dir as well as the common dir', async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'lander-codex-gitdirs-')))
    try {
      const git = (cwd: string, ...args: string[]) =>
        execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
      git(root, 'init', '-q')
      git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x')
      const wt = path.join(root, '.worktrees', 't1')
      git(root, 'worktree', 'add', '-q', '--detach', wt)
      const launch = await runCodex(
        { task: {}, prompt: 'work', root, cwd: wt, checkout: wt },
        { resolveGitDirs: undefined },
      )
      const joined = launch.args.join('\0')
      expect(joined).toContain(`"${path.join(root, '.git')}"="write"`)
      expect(joined).toContain(`"${path.join(root, '.git', 'worktrees', 't1')}"="write"`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('grants worktrees access to the resolved Git dirs', async () => {
    const options: Partial<CodexFlowDeps> = {
      taskPromptTemplate: TASK_PROMPT_TEMPLATE,
      resolveGitDirs: (cwd) => {
        expect(cwd).toBe('/worktrees/feature')
        return ['/repo/.git']
      },
    }

    const launch = await runCodex({
      task: {},
      prompt: 'edit worktree',
      root: '/worktrees/feature',
      cwd: '/worktrees/feature',
      env: {},
    }, options)

    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      ...permissionArgs('/worktrees/feature', ['/repo/.git']),
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--cd',
      '/worktrees/feature',
      '--',
      managedPrompt('edit worktree'),
    ])
  })

  it('builds Codex resume args from the provider session id', async () => {
    const launch = await runCodex({
      task: {
        sessionId: '019f0000-0000-7000-8000-000000000001',
      },
      prompt: 'follow up',
      root: '/repo',
      cwd: '/repo/subdir',
      env: { LANDER_TASK: 'task-1' },
    })

    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      ...permissionArgs(),
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
      managedPrompt('follow up'),
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
      },
      prompt: 'configured follow up',
      root: '/repo',
      cwd: '/repo/subdir',
      env: { LANDER_TASK: 'task-1' },
    }, options)

    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--profile',
      'lander-codex',
      '--config',
      'model="gpt-5-codex"',
      '--config',
      'approval_policy="never"',
      ...permissionArgs(),
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
      managedPrompt('configured follow up'),
    ])
  })

  it('adds optional Codex profile and config flags before per-run env config', async () => {
    const options: Partial<CodexFlowDeps> = {
      taskPromptTemplate: TASK_PROMPT_TEMPLATE,
      profile: 'lander-codex',
      configOverrides: ['model="gpt-5-codex"', 'approval_policy="never"'],
    }
    const launch = await runCodex({
      task: {},
      prompt: 'use configured codex',
      root: '/repo',
      cwd: '/repo',
      env: { LANDER_TASK: 'task-1' },
    }, options)

    expect(launch.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--profile',
      'lander-codex',
      '--config',
      'model="gpt-5-codex"',
      '--config',
      'approval_policy="never"',
      ...permissionArgs(),
      '--config',
      'shell_environment_policy.inherit=all',
      '--config',
      'shell_environment_policy.ignore_default_excludes=true',
      '--config',
      'shell_environment_policy.include_only=["PATH","LANDER_*"]',
      '--cd',
      '/repo',
      '--',
      managedPrompt('use configured codex'),
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
      task: {},
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
      task: {},
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
    const launch = await runCodex({ task: {}, root: '/repo', cwd: '/repo' })
    expect(launch.events.filter((e) => e.kind === 'state-patch')).toEqual([])
  })

  it('leaves the stdin banner out of a failed run’s stderr', async () => {
    const { result } = await driveFlow(
      {
        name: 'out of credits',
        chunks: [],
        exitCode: 1,
        stderrChunks: [
          'Reading additional input from stdin...\nYour workspace is out of credits.\n',
        ],
      },
      codexFlow(),
    )
    expect(result).toEqual({ exitCode: 1, stderr: 'Your workspace is out of credits.' })
  })
})
