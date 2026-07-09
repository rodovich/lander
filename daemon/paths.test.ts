import { describe, expect, it } from 'vitest'
import type { AgentAdapter } from './agent'
import type { StartRunMessage } from '../server/protocol'
import { resolveRunCwd } from './paths'

const claude = { supportsWorktreeFlag: true } as AgentAdapter
const codex = { supportsWorktreeFlag: false } as AgentAdapter

function start(over: Partial<StartRunMessage> = {}): StartRunMessage {
  return {
    type: 'start-run',
    runId: 'run-1',
    taskId: 'task-1',
    agent: 'claude',
    project: 'proj',
    prompt: 'p',
    task: { allowEdits: false },
    env: {},
    idleTimeoutMs: 60_000,
    ...over,
  }
}

const yes = () => true

describe('resolveRunCwd', () => {
  it('keeps a worktree-flag provider at root so it re-enters via --worktree', () => {
    const msg = start({
      task: { allowEdits: false, worktree: 'feature' },
      recordedCwd: '/repo/.claude/worktrees/feature',
    })
    // Even with a recorded worktree cwd, Claude launches from root — the reason
    // buildTurnContext must resolve the worktree path itself for the snapshot.
    expect(resolveRunCwd(msg, claude, '/repo', yes)).toBe('/repo')
  })

  it('resumes a worktree-less provider from its recorded cwd when it exists', () => {
    const msg = start({ agent: 'codex', recordedCwd: '/repo/sub' })
    expect(resolveRunCwd(msg, codex, '/repo', yes)).toBe('/repo/sub')
  })

  it('falls back to root when the recorded cwd is gone', () => {
    const msg = start({ agent: 'codex', recordedCwd: '/repo/sub' })
    expect(resolveRunCwd(msg, codex, '/repo', () => false)).toBe('/repo')
  })

  it('uses the recorded cwd for a worktree-flag provider with no worktree set', () => {
    const msg = start({ recordedCwd: '/repo/sub' })
    expect(resolveRunCwd(msg, claude, '/repo', yes)).toBe('/repo/sub')
  })

  it('stays at root when there is no cwd hint', () => {
    expect(resolveRunCwd(start(), claude, '/repo', yes)).toBe('/repo')
  })
})
