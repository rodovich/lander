import { describe, expect, it } from 'vitest'
import { agentDisplayName, formatAgentModelName } from './agentDisplay'

describe('agentDisplayName', () => {
  it('maps known agent ids to user-facing names', () => {
    expect(agentDisplayName('claude')).toBe('Claude')
    expect(agentDisplayName('codex')).toBe('Codex')
  })

  it('falls back to a trimmed custom name or Assistant', () => {
    expect(agentDisplayName('  Local agent  ')).toBe('Local agent')
    expect(agentDisplayName(undefined)).toBe('Assistant')
  })
})

describe('formatAgentModelName', () => {
  it('shows just the agent name when no model is known', () => {
    expect(formatAgentModelName('Codex')).toBe('Codex')
  })

  it('adds the model in parentheses when known', () => {
    expect(formatAgentModelName('Claude', 'claude-fable-5')).toBe(
      'Claude (claude-fable-5)',
    )
  })

  it('trims blank inputs before formatting', () => {
    expect(formatAgentModelName('  Claude  ', '  opus  ')).toBe(
      'Claude (opus)',
    )
    expect(formatAgentModelName('', '')).toBe('Assistant')
  })
})
