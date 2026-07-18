// The neutral git-snapshot helper for the flow stdlib. It reads branch / default
// branch / working tree / recent commits from a cwd — nothing provider-specific —
// so it belongs to every driver, not to Claude. It lived in daemon/claude.ts until
// the stdlib existed; the claude-specific part (the `<task-context>` block that
// weaves the live permission grants around this snapshot) stays with claude.

import { execFileSync } from 'node:child_process'

// Cap the working-tree listing so a huge dirty tree can't bloat the turn
// context (and with it the task file and the tokens re-sent on every change).
const GIT_STATUS_MAX_LINES = 40

// The git snapshot for a driver's per-turn context block: the same facts Claude's
// built-in system-prompt block carried (branch, default branch, working tree,
// recent commits), reworded for a block that *does* refresh as the conversation
// goes. Returns undefined outside a git work tree (or when git fails/times out),
// so the caller's context degrades to whatever else it had.
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
