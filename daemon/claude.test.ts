import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createClaudeAdapter, gitContext } from './claude'

const adapter = createClaudeAdapter({
  landerBin: '/repo/bin/lander',
  taskPromptTemplate: 'Prompt: {{forwardable}}.',
  readGitContext: (cwd) => `Git status as of this message:\n\ncwd ${cwd}`,
})

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('Claude adapter', () => {
  it('builds the existing Claude launch argv behind the adapter', () => {
    const launch = adapter.buildLaunch({
      task: {
        allowEdits: true,
        allowCommits: true,
        allow: ['Bash(npm test)'],
        worktree: 'feature',
      },
      prompt: '-starts-with-dash',
      root: '/repo',
      cwd: '/repo',
      landerEnv: { LANDER_TASK: 'task-1' },
    })

    expect(launch.env).toEqual({ LANDER_TASK: 'task-1' })
    expect(launch.args.slice(0, 9)).toEqual([
      '--worktree',
      'feature',
      '--allowedTools',
      'Bash(lander:*)',
      'Edit',
      'Write',
      'MultiEdit',
      'Bash(git:*)',
      'Bash(npm test)',
    ])
    expect(launch.args.slice(-6)).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '-p',
      '--',
      '-starts-with-dash',
    ])

    const settings = JSON.parse(launch.args[launch.args.indexOf('--settings') + 1])
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
      '/repo/bin/lander bash-guard',
    )
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe(
      '/repo/bin/lander record-worktree',
    )
    expect(settings.hooks.PostToolUse[1].hooks[0].command).toBe(
      '/repo/bin/lander clear-worktree',
    )
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(
      '/repo/bin/lander record-cwd',
    )

    const systemPrompt = launch.args[launch.args.indexOf('--append-system-prompt') + 1]
    // The appended prompt is static across turns: the live grants moved to the
    // task-context block, leaving a fixed pointer in the {{forwardable}} slot.
    expect(systemPrompt).toContain(
      'Prompt: Your own current grants — which cap what you can forward — are ' +
        'stated in the task-context block in the conversation.',
    )
    // The kept git tips, minus the sign-off conventions that
    // includeGitInstructions:false removed along with the status snapshot.
    expect(systemPrompt).toContain('# Git')
    expect(systemPrompt).toContain('gh')
    expect(systemPrompt).not.toContain('Co-Authored-By')
    expect(settings.includeGitInstructions).toBe(false)
  })

  it('builds the per-turn context block from grants and the git snapshot', () => {
    const context = adapter.buildTurnContext?.({
      task: { allowEdits: true, allowCommits: true },
      root: '/repo',
      cwd: '/repo/worktree',
    })
    expect(context).toContain('<task-context>')
    expect(context).toContain(
      'You currently have permission for editing files and git commits',
    )
    expect(context).toContain('cwd /repo/worktree')
    expect(context).toContain('</task-context>')
  })

  it('degrades the context block to just the grants outside a git repo', () => {
    const noGit = createClaudeAdapter({
      landerBin: '/repo/bin/lander',
      taskPromptTemplate: 'Prompt: {{forwardable}}.',
      readGitContext: () => undefined,
    })
    const context = noGit.buildTurnContext?.({
      task: { allowEdits: false, allowCommits: false },
      root: '/repo',
      cwd: '/repo',
    })
    expect(context).toContain('You currently have no edit or commit permissions')
    expect(context).not.toContain('Git status')
  })

  it('builds Claude start and resume session arguments', () => {
    expect(
      adapter.buildSession({
        sessionId: 'existing',
        mintSessionId: () => 'new',
      }),
    ).toEqual({
      args: ['--resume', 'existing'],
      sessionId: 'existing',
      announceSession: false,
    })

    expect(
      adapter.buildSession({
        mintSessionId: () => 'minted',
      }),
    ).toEqual({
      args: ['--session-id', 'minted'],
      sessionId: 'minted',
      announceSession: true,
    })
  })

  it('wraps the Claude stream-json reducer', () => {
    expect(
      adapter.reduceLine(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hello' }] },
        }),
        '2026-01-01T00:00:00.000Z',
      ),
    ).toMatchObject({
      steps: [
        {
          kind: 'text',
          text: 'hello',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      finalText: 'hello',
    })
  })

  it('reads a real git snapshot: branch, status, recent commits', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lander-git-'))
    tempDirs.push(dir)
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
        { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    git('init', '-b', 'work')
    await writeFile(path.join(dir, 'a.txt'), 'a')
    git('add', 'a.txt')
    git('commit', '-m', 'first commit')
    await writeFile(path.join(dir, 'b.txt'), 'b')

    const snapshot = gitContext(dir)
    expect(snapshot).toContain('Current branch: work')
    expect(snapshot).toContain('?? b.txt')
    expect(snapshot).toContain('first commit')
  })

  it('returns no git snapshot outside a repository', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lander-nogit-'))
    tempDirs.push(dir)
    expect(gitContext(dir)).toBeUndefined()
  })

  it('persists project grants in Claude settings.local.json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lander-claude-'))
    tempDirs.push(dir)

    await adapter.persistProjectGrant?.({
      projectPath: dir,
      rule: 'Bash(npm test)',
    })
    await adapter.persistProjectGrant?.({
      projectPath: dir,
      rule: 'Bash(npm test)',
    })

    const settings = JSON.parse(
      await readFile(path.join(dir, '.claude', 'settings.local.json'), 'utf8'),
    )
    expect(settings.permissions.allow).toEqual(['Bash(npm test)'])
  })
})
