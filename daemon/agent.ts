import type { AgentKind } from '../server/agent'
import type { Step, Usage } from '../server/stream'

export type AgentTaskView = {
  agent?: AgentKind
  sessionId?: string
  allowEdits: boolean
  allowCommits: boolean
  allow?: string[]
  worktree?: string
}

export type AgentLaunchInput<TTask extends AgentTaskView = AgentTaskView> = {
  task: TTask
  prompt: string
  root: string
  cwd: string
  landerEnv: Record<string, string>
}

export type AgentLaunch = {
  args: string[]
  env?: Record<string, string>
}

export type AgentSessionInput = {
  sessionId?: string
  mintSessionId: () => string
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
  reduceLine(line: string, at: string): AgentLineUpdate
  extractSession?(line: string): string | undefined
  persistProjectGrant?(input: AgentProjectGrantInput): Promise<void>
  supportsProjectGrants: boolean
  supportsWorktreeFlag: boolean
  supportsUsageSnapshot: boolean
  supportsRateLimitRetryScheduling: boolean
}
