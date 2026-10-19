import { describe, it, expect } from 'vitest'
import { AGENT_KINDS, isAgentKind } from './agent'

describe('agent adapter contract', () => {
  it('recognizes the supported agent kinds', () => {
    expect(AGENT_KINDS).toEqual(['claude', 'codex'])
    expect(isAgentKind('claude')).toBe(true)
    expect(isAgentKind('codex')).toBe(true)
    expect(isAgentKind('other')).toBe(false)
    expect(isAgentKind(null)).toBe(false)
  })
})
