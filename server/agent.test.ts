import { describe, it, expect } from 'vitest'
import {
  AGENT_KINDS,
  defaultAgentFromEnv,
  isAgentKind,
} from './agent'

describe('agent adapter contract', () => {
  it('recognizes the supported agent kinds', () => {
    expect(AGENT_KINDS).toEqual(['claude', 'codex'])
    expect(isAgentKind('claude')).toBe(true)
    expect(isAgentKind('codex')).toBe(true)
    expect(isAgentKind('other')).toBe(false)
    expect(isAgentKind(null)).toBe(false)
  })

  it('resolves the environment default for new tasks', () => {
    expect(defaultAgentFromEnv({})).toBe('claude')
    expect(defaultAgentFromEnv({ LANDER_AGENT: 'claude' })).toBe('claude')
    expect(defaultAgentFromEnv({ LANDER_AGENT: 'codex' })).toBe('codex')
    expect(defaultAgentFromEnv({ LANDER_AGENT: ' CODEX ' })).toBe('codex')
    expect(defaultAgentFromEnv({ LANDER_AGENT: 'other' })).toBe('claude')
  })
})
