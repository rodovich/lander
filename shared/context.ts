export type ContextAction = 'compaction' | 'checkpoint'

export type ContextDetails = {
  trigger?: 'auto' | 'manual'
  beforeTokens?: number
  afterTokens?: number
  durationMs?: number
}

export type ContextUpdate = ContextDetails & {
  action: ContextAction
  phase: 'started' | 'completed' | 'idle'
}

export function contextLabel(action: ContextAction): string {
  return action === 'compaction' ? 'Context compacted' : 'Context checkpoint created'
}

export function contextSummary(details: ContextDetails): string {
  const parts: string[] = []
  if (details.trigger) parts.push(details.trigger === 'auto' ? 'automatic' : 'manual')
  const before = details.beforeTokens?.toLocaleString('en-US')
  const after = details.afterTokens?.toLocaleString('en-US')
  if (before !== undefined && after !== undefined) parts.push(`${before} → ${after} tokens`)
  else if (before !== undefined) parts.push(`${before} tokens before`)
  else if (after !== undefined) parts.push(`${after} tokens after`)
  return parts.join(' · ')
}

export function contextDuration(details: ContextDetails): string | undefined {
  return details.durationMs === undefined
    ? undefined
    : `${(details.durationMs / 1000).toLocaleString('en-US', { maximumFractionDigits: 2 })} seconds`
}
