import type { Step, Usage } from './stream'

export const AGENT_KINDS = ['claude', 'codex'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && AGENT_KINDS.includes(value as AgentKind)
}

// The task fields an adapter may need to build a launch. Keep this structural so
// server/index.ts can pass its full Task without importing the server entrypoint
// into provider-specific modules.
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
  // The configured project root and the resolved launch directory for this run.
  // They can differ when a prior turn ended in a subdirectory or worktree.
  root: string
  cwd: string
  // Environment lander injects into the agent process so in-task lander commands
  // can call back to the server.
  landerEnv: Record<string, string>
}

export type AgentLaunch = {
  command: string
  args: string[]
  env?: Record<string, string>
  // Providers that know the session before spawn, such as Claude with a minted
  // --session-id, report it here. Providers that announce it in JSONL can use
  // extractSession instead.
  sessionId?: string
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
}

export type AgentProjectGrantInput = {
  projectPath: string
  rule: string
}

export type AgentHookStrategy =
  | 'inline-launch'
  | 'project-config'
  | 'unsupported'

export type AgentAdapter = {
  kind: AgentKind
  buildLaunch(input: AgentLaunchInput): AgentLaunch
  reduceLine(line: string, at: string): AgentLineUpdate
  extractSession?(line: string): string | undefined
  persistProjectGrant?(input: AgentProjectGrantInput): Promise<void>
  hookStrategy: AgentHookStrategy
  supportsProjectGrants: boolean
  supportsWorktreeFlag: boolean
  supportsUsageSnapshot: boolean
}
