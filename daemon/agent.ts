import type { AgentKind } from '../server/agent'

export type AgentTaskView = {
  agent?: AgentKind
  sessionId?: string
  allowEdits: boolean
  allow?: string[]
  worktree?: string
}

// The launch directory a flow resolves for its next turn: where the child is
// spawned, the extra argv it needs to reach its intended working state, and where
// the shell actually lands once that argv applies (when different from cwd).
export type AgentLaunchDir = {
  // Dir the child process is spawned in — the config-load root and (for Claude)
  // the permission boundary.
  cwd: string
  // Extra argv prepended to the launch to reach the intended working state
  // (Claude: ['--worktree', name]). Empty when the spawn cwd already suffices.
  reentryArgs: string[]
  // Where the shell lands once reentryArgs apply, if different from cwd (Claude's
  // worktree path). Absent when the shell simply stays in cwd.
  effectiveCwd?: string
}

export type AgentLaunchDirInput = {
  root: string
  // The cwd the previous turn's shell ended in (task.cwd), if any.
  recordedCwd?: string
  // The worktree the task is currently in, if any (Claude re-enters it via argv).
  worktree?: string
  // Injectable directory probe, so tests don't touch the filesystem.
  isDir(p: string): boolean
}
