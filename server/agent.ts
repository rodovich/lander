export const AGENT_KINDS = ['claude', 'codex'] as const
export type AgentKind = (typeof AGENT_KINDS)[number]

export function isAgentKind(value: unknown): value is AgentKind {
  return typeof value === 'string' && AGENT_KINDS.includes(value as AgentKind)
}
