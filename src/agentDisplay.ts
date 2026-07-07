export function agentDisplayName(agent: string | undefined): string {
  switch (agent) {
    case 'claude':
      return 'Claude'
    case 'codex':
      return 'Codex'
    default: {
      const name = agent?.trim()
      return name || 'Assistant'
    }
  }
}

export function formatAgentModelName(
  agentName: string,
  modelName?: string,
): string {
  const name = agentName.trim() || 'Assistant'
  const model = modelName?.trim()
  return model ? `${name} (${model})` : name
}
