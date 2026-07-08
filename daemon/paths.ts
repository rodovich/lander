import { statSync } from 'node:fs'
import type { AgentAdapter } from './agent'
import type { StartRunMessage } from '../server/protocol'

function defaultIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

// Resolve a start-run's launch cwd under the given project root. Providers with
// a real worktree flag launch from the root and re-enter the worktree through
// argv (--worktree), so their cwd stays root; providers without one resume from
// the recorded cwd when it still exists, else fall back to root. `isDir` is
// injectable for tests.
export function resolveRunCwd(
  msg: StartRunMessage,
  adapter: AgentAdapter,
  root: string,
  isDir: (p: string) => boolean = defaultIsDir,
): string {
  if (adapter.supportsWorktreeFlag && msg.task.worktree) return root
  if (msg.recordedCwd && msg.recordedCwd !== root && isDir(msg.recordedCwd))
    return msg.recordedCwd
  return root
}
