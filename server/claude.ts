import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentAdapter, AgentTaskView } from './agent'
import { reduceStreamLine } from './stream'

export type ClaudeAdapterOptions = {
  landerBin: string
  taskPromptTemplate: string
}

export function createClaudeAdapter({
  landerBin,
  taskPromptTemplate,
}: ClaudeAdapterOptions): AgentAdapter {
  return {
    kind: 'claude',
    command: 'claude',
    buildLaunch({ task, prompt, landerEnv }) {
      return {
        command: 'claude',
        args: buildClaudeArgs(task, prompt, { landerBin, taskPromptTemplate }),
        env: landerEnv,
      }
    },
    buildSession({ sessionId, mintSessionId }) {
      if (sessionId)
        return {
          args: ['--resume', sessionId],
          sessionId,
          announceSession: false,
        }
      const minted = mintSessionId()
      return {
        args: ['--session-id', minted],
        sessionId: minted,
        announceSession: true,
      }
    },
    reduceLine: reduceStreamLine,
    persistProjectGrant: persistClaudeProjectGrant,
    hookStrategy: 'inline-launch',
    supportsProjectGrants: true,
    supportsWorktreeFlag: true,
    supportsUsageSnapshot: true,
  }
}

function buildClaudeArgs(
  task: AgentTaskView,
  prompt: string,
  {
    landerBin,
    taskPromptTemplate,
  }: {
    landerBin: string
    taskPromptTemplate: string
  },
): string[] {
  const worktreeArgs = task.worktree ? ['--worktree', task.worktree] : []
  const allowed: string[] = ['Bash(lander:*)']
  if (task.allowEdits) allowed.push('Edit', 'Write', 'MultiEdit')
  if (task.allowCommits) allowed.push('Bash(git:*)')
  if (task.allow?.length) allowed.push(...task.allow)
  const editArgs = allowed.length ? ['--allowedTools', ...allowed] : []

  const held = [
    task.allowEdits && 'editing files',
    task.allowCommits && 'git commits',
  ].filter(Boolean) as string[]
  const forwardable = held.length
    ? `You currently have permission for ${held.join(' and ')}, and can ` +
      'forward that to a spawned task'
    : 'You currently have no edit or commit permissions, so a spawned task ' +
      'cannot be granted them either'

  const hookSettings = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `${landerBin} bash-guard`,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'EnterWorktree',
          hooks: [
            {
              type: 'command',
              command: `${landerBin} record-worktree`,
            },
          ],
        },
        {
          matcher: 'ExitWorktree',
          hooks: [
            {
              type: 'command',
              command: `${landerBin} clear-worktree`,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `${landerBin} record-cwd`,
            },
          ],
        },
      ],
    },
  })

  return [
    ...worktreeArgs,
    ...editArgs,
    '--settings',
    hookSettings,
    '--append-system-prompt',
    taskPromptTemplate.replace('{{forwardable}}', forwardable),
    '--output-format',
    'stream-json',
    '--verbose',
    '-p',
    '--',
    prompt,
  ]
}

async function persistClaudeProjectGrant({
  projectPath,
  rule,
}: {
  projectPath: string
  rule: string
}): Promise<void> {
  const dir = path.join(projectPath, '.claude')
  const file = path.join(dir, 'settings.local.json')
  let settings: Record<string, any> = {}
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed && typeof parsed === 'object') settings = parsed
  } catch {
    // missing or invalid — start fresh
  }
  const perms = (settings.permissions ??= {})
  const allow: string[] = Array.isArray(perms.allow)
    ? perms.allow
    : (perms.allow = [])
  if (!allow.includes(rule)) allow.push(rule)
  await mkdir(dir, { recursive: true })
  await writeFile(file, JSON.stringify(settings, null, 2) + '\n')
}
