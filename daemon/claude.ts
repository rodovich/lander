import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AgentAdapter, AgentTaskView } from './agent'
import { reduceStreamLine } from '../server/stream'
import { fillTaskPrompt, forwardableAccess } from './task-management'

export type ClaudeAdapterOptions = {
  landerBin: string
  taskPromptTemplate: string
  // The git-snapshot reader behind buildTurnContext, injectable for tests.
  // Returns the formatted snapshot, or undefined outside a git repository.
  readGitContext?: (cwd: string) => string | undefined
}

// Claude regenerates its default system prompt every invocation, and lander runs
// one `claude -p` process per turn — so anything dynamic in that prompt (the git
// status snapshot changes on any commit or file edit) busts the prompt cache for
// the entire conversation on the next turn. includeGitInstructions:false removes
// the snapshot along with the built-in git workflow instructions; the snapshot
// moves into the per-turn task-context block (buildTurnContext), and the
// instructions worth keeping return as static text below.

// The environment/workflow git tips from Claude's built-in git instructions,
// minus the commit/PR sign-off conventions (Co-Authored-By, PR attribution),
// which lander deliberately drops.
const GIT_TIPS = [
  '# Git',
  '- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.',
  '- Use the `gh` CLI for GitHub operations (PRs, issues, API).',
  '- Commit or push only when the user asks. If on the default branch, branch first.',
].join('\n')

// The static stand-in for the template's {{forwardable}} slot: the live grants
// sentence moved to the task-context block so the appended system prompt stays
// byte-stable across turns (see forwardableAccess / buildTurnContext).
const FORWARDABLE_POINTER =
  'Your own current grants — which cap what you can forward — are stated in ' +
  'the task-context block in the conversation'

export function createClaudeAdapter({
  landerBin,
  taskPromptTemplate,
  readGitContext = gitContext,
}: ClaudeAdapterOptions): AgentAdapter {
  return {
    kind: 'claude',
    command: 'claude',
    buildLaunch({ task, prompt, landerEnv }) {
      return {
        args: buildClaudeArgs(task, prompt, { landerBin, taskPromptTemplate }),
        env: landerEnv,
      }
    },
    buildTurnContext({ task, root, cwd }) {
      const parts = [`${forwardableAccess(task)}.`]
      // A worktree Claude task launches from the project root (resolveRunPaths
      // hands cwd=root, since Claude re-enters the worktree via --worktree) — so
      // read the snapshot from the worktree itself, not root, or the block would
      // describe the wrong branch and dirty tree. The worktree lives at the same
      // <root>/.claude/worktrees/<name> path `--worktree <name>` re-enters.
      const gitCwd = task.worktree
        ? path.join(root, '.claude', 'worktrees', task.worktree)
        : cwd
      const git = readGitContext(gitCwd)
      if (git) parts.push(git)
      return [
        '<task-context>',
        'Task state as of this message — background context from lander, not ' +
          "the user's words. Re-sent only when it changes.",
        '',
        parts.join('\n\n'),
        '</task-context>',
      ].join('\n')
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
    supportsProjectGrants: true,
    supportsWorktreeFlag: true,
    supportsUsageSnapshot: true,
    supportsRateLimitRetryScheduling: true,
    // Claude has no vision flag on the CLI: it Reads an image by its local path
    // (rendered visually), which the daemon lists in the manifest block.
    attachesImagesToVision: false,
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
  // Edit access is the only grant Lander injects into --allowedTools; git and
  // other Bash follow the project's normal .claude permissions (settings.json /
  // settings.local.json) plus any per-task allow rules below.
  const allowed: string[] = ['Bash(lander:*)']
  if (task.allowEdits) allowed.push('Edit', 'Write', 'MultiEdit')
  if (task.allow?.length) allowed.push(...task.allow)
  const editArgs = allowed.length ? ['--allowedTools', ...allowed] : []

  const hookSettings = JSON.stringify({
    // Keep the git status snapshot (and built-in git workflow instructions) out
    // of the regenerated-per-turn system prompt — see the note on GIT_TIPS.
    includeGitInstructions: false,
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
    `${fillTaskPrompt(taskPromptTemplate, FORWARDABLE_POINTER)}\n\n${GIT_TIPS}`,
    '--output-format',
    'stream-json',
    '--verbose',
    '-p',
    '--',
    prompt,
  ]
}

// Cap the working-tree listing so a huge dirty tree can't bloat the turn
// context (and with it the task file and the tokens re-sent on every change).
const GIT_STATUS_MAX_LINES = 40

// The git snapshot for the task-context block: the same facts Claude's built-in
// system-prompt block carried (branch, default branch, working tree, recent
// commits), reworded for a block that *does* refresh as the conversation goes.
// Returns undefined outside a git work tree (or when git fails/times out), so
// the context degrades to just the grants sentence.
export function gitContext(cwd: string): string | undefined {
  const git = (...args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 3_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return undefined
    }
  }
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch === undefined) return undefined
  // The default branch: prefer the remote's HEAD, fall back to a local
  // main/master, omit the line when neither resolves.
  const originHead = git('rev-parse', '--abbrev-ref', 'origin/HEAD')
  const mainBranch =
    originHead?.replace(/^origin\//, '') ||
    ['main', 'master'].find((b) => git('rev-parse', '--verify', '--quiet', b))
  let status = git('status', '--porcelain') ?? ''
  const statusLines = status.split('\n')
  if (statusLines.length > GIT_STATUS_MAX_LINES)
    status =
      statusLines.slice(0, GIT_STATUS_MAX_LINES).join('\n') +
      `\n… (+${statusLines.length - GIT_STATUS_MAX_LINES} more)`
  const commits = git('log', '--oneline', '-5') ?? ''
  return [
    'Git status as of this message:',
    '',
    `Current branch: ${branch}`,
    ...(mainBranch
      ? [`Main branch (you will usually use this for PRs): ${mainBranch}`]
      : []),
    '',
    'Status:',
    status || '(clean)',
    '',
    'Recent commits:',
    commits || '(none)',
  ].join('\n')
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
