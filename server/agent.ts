export const AGENT_KINDS = ['claude', 'codex'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && AGENT_KINDS.includes(value as AgentKind)
}

export function defaultAgentFromEnv(env: {
  LANDER_AGENT?: string | undefined
}): AgentKind {
  const value = env.LANDER_AGENT?.trim().toLowerCase()
  return isAgentKind(value) ? value : 'claude'
}
