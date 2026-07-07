import { describe, expect, it } from 'vitest'
import type { AgentAdapter, AgentLaunchInput } from './agent'

describe('daemon agent adapter contract', () => {
  it('keeps launch construction and line reduction behind one provider shape', () => {
    const adapter: AgentAdapter = {
      kind: 'claude',
      command: 'claude',
      buildLaunch(input: AgentLaunchInput) {
        return {
          args: ['-p', input.prompt],
          env: input.landerEnv,
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
      args: ['-p', 'hello'],
      env: { LANDER_TASK: 't1' },
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
