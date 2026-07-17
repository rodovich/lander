import type { AgentKind } from '../server/agent'
import type { Step, Usage } from '../server/stream'

export type AgentTaskView = {
  agent?: AgentKind
  sessionId?: string
  allowEdits: boolean
  allow?: string[]
  worktree?: string
}

export type AgentLaunchInput<TTask extends AgentTaskView = AgentTaskView> = {
  task: TTask
  prompt: string
  root: string
  cwd: string
  landerEnv: Record<string, string>
  // Absolute local paths of this turn's image attachments, materialized by the
  // daemon. Providers with a native vision flag (Codex --image) pass them to the
  // child; others ignore them (Claude reads the path from the manifest). Empty
  // when the turn has no images.
  images?: string[]
  // The task's materialized attachment store dir, set only when it exists (the
  // task has attachments from this or an earlier turn). Claude adds it as a Read
  // workspace root (--add-dir) so it can open an attached image sitting outside
  // the task cwd; Codex ignores it (it gets pixels via --image). Absent for tasks
  // with no attachments.
  filesDir?: string
}

export type AgentLaunch = {
  args: string[]
  env?: Record<string, string>
}

export type AgentSessionInput = {
  sessionId?: string
  mintSessionId: () => string
}

export type AgentContextInput = {
  task: AgentTaskView
  root: string
  cwd: string
  // Where the shell actually lands once this turn's re-entry argv applies, when it
  // differs from cwd (Claude re-enters a worktree from a root launch). The git
  // snapshot reads from here so the block describes the worktree, not root.
  effectiveCwd?: string
  // The cwd the previous turn's shell ended in (task.cwd), if any. Compared against
  // the landed dir to warn when a manual `cd` won't be restored this turn.
  recordedCwd?: string
}

// The launch directory an adapter owns for its next turn: where the child is
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

export type AgentSessionLaunch = {
  args: string[]
  sessionId?: string
  announceSession: boolean
}

export type AgentLineUpdate = {
  steps: Step[]
  finalText?: string
  blockedIds?: string[]
  usage?: Usage
  usageInferenceId?: string
  usageFinal?: boolean
  drivingModel?: string
  rateLimitResetsAt?: string
  terminalError?: string
}

export type AgentProjectGrantInput = {
  projectPath: string
  rule: string
}

export type AgentAdapter = {
  kind: AgentKind
  command: string
  buildLaunch(input: AgentLaunchInput): AgentLaunch
  buildSession(input: AgentSessionInput): AgentSessionLaunch
  // The directory this adapter launches its next turn in, plus any re-entry argv
  // (and where the shell lands after it). The daemon no longer knows or cares
  // whether an adapter has worktrees: it launches where the adapter says and
  // appends reentryArgs. Claude launches at root and re-enters a worktree via
  // ['--worktree', name] (so its permission boundary never moves with a manual
  // cd); Codex resumes from the recorded cwd, preserving its --cd behavior.
  resolveLaunchDir(input: AgentLaunchDirInput): AgentLaunchDir
  // Build the dynamic per-turn context block (current git snapshot, live
  // permission grants, …) the run manager appends to the outgoing user message —
  // dynamic facts belong at the cache-friendly end of the conversation, not in
  // the system prompt where any change invalidates the whole cached prefix. Called
  // fresh each turn; the block is appended (and reported back for the server to
  // record as task.turnContext) only when it differs from the last block this
  // session received (StartRunMessage.turnContext). Optional: an adapter without
  // one (Codex) sends the user's prompt untouched.
  buildTurnContext?(input: AgentContextInput): string
  reduceLine(line: string, at: string): AgentLineUpdate
  extractSession?(line: string): string | undefined
  persistProjectGrant?(input: AgentProjectGrantInput): Promise<void>
  // The human-facing reason shown when a project-scope grant is refused because
  // this adapter can't persist one (used only when `!supportsProjectGrants`). Lets
  // the daemon source the message from the adapter instead of branching on the
  // agent name. Optional: an adapter that supports grants never needs it, and one
  // that doesn't but omits it falls back to a generic message.
  projectGrantsUnsupportedReason?: string
  supportsProjectGrants: boolean
  supportsUsageSnapshot: boolean
  supportsRateLimitRetryScheduling: boolean
  // Whether the provider delivers image attachments to its vision itself, given
  // their paths in buildLaunch (Codex --image). False when the agent must Read
  // the path instead (Claude) — the daemon then words the manifest block to say
  // so. Drives only the block wording; every provider still gets the paths.
  attachesImagesToVision: boolean
}
