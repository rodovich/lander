import { describe, it, expect } from 'vitest'
import {
  AGENT_KINDS,
  isAgentKind,
  type AgentAdapter,
  type AgentLaunchInput,
} from './agent'

describe('agent adapter contract', () => {
  it('recognizes the supported agent kinds', () => {
    expect(AGENT_KINDS).toEqual(['claude', 'codex'])
    expect(isAgentKind('claude')).toBe(true)
    expect(isAgentKind('codex')).toBe(true)
    expect(isAgentKind('other')).toBe(false)
    expect(isAgentKind(null)).toBe(false)
  })

  it('keeps launch construction and line reduction behind one provider shape', () => {
    const adapter: AgentAdapter = {
      kind: 'claude',
      command: 'claude',
      buildLaunch(input: AgentLaunchInput) {
        return {
          command: 'claude',
          args: ['-p', input.prompt],
          env: input.landerEnv,
          sessionId: input.task.sessionId,
        }
      },
      buildSession({ sessionId, mintSessionId }) {
        const resolved = sessionId ?? mintSessionId()
        return {
          args: sessionId ? ['--resume', sessionId] : ['--session-id', resolved],
          sessionId: resolved,
          announceSession: sessionId === undefined,
        }
      },
      reduceLine(_line, at) {
        return { steps: [{ kind: 'text', text: 'ok', createdAt: at }] }
      },
      hookStrategy: 'inline-launch',
      supportsProjectGrants: true,
      supportsTaskAllowRules: true,
      supportsWorktreeFlag: true,
      supportsUsageSnapshot: true,
      supportsRateLimitRetryScheduling: true,
    }

    const launch = adapter.buildLaunch({
      task: {
        sessionId: 's1',
        allowEdits: false,
        allowCommits: false,
      },
      prompt: 'hello',
      root: '/repo',
      cwd: '/repo',
      landerEnv: { LANDER_TASK: 't1' },
    })

    expect(launch).toEqual({
      command: 'claude',
      args: ['-p', 'hello'],
      env: { LANDER_TASK: 't1' },
      sessionId: 's1',
    })
    expect(adapter.reduceLine('{}', '2026-01-01T00:00:00.000Z').steps).toEqual([
      {
        kind: 'text',
        text: 'ok',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])
  })
})
