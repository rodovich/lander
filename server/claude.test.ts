import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createClaudeAdapter } from './claude'

const adapter = createClaudeAdapter({
  landerBin: '/repo/bin/lander',
  taskPromptTemplate: 'Prompt: {{forwardable}}.',
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

    expect(launch.command).toBe('claude')
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
    expect(systemPrompt).toContain(
      'You currently have permission for editing files and git commits',
    )
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
