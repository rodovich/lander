export function agentDisplayName(agent: string | undefined): string {
  switch (agent) {
    case 'claude':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'agy':
      return 'Antigravity'
    default: {
      const name = agent?.trim()
      return name || 'Assistant'
    }
  }
}

export function formatAgentModelName(
  agentName: string,
  modelName?: string,
  effort?: string,
): string {
  const name = agentName.trim() || 'Assistant'
  const model = modelName?.trim()
  if (!model) return name
  return effort ? `${name} (${model}, ${effort} effort)` : `${name} (${model})`
}
