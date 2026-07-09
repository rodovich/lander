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
  supportsProjectGrants: boolean
  supportsWorktreeFlag: boolean
  supportsUsageSnapshot: boolean
  supportsRateLimitRetryScheduling: boolean
  // Whether the provider delivers image attachments to its vision itself, given
  // their paths in buildLaunch (Codex --image). False when the agent must Read
  // the path instead (Claude) — the daemon then words the manifest block to say
  // so. Drives only the block wording; every provider still gets the paths.
  attachesImagesToVision: boolean
}
