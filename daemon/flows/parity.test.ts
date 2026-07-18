// Old adapter vs new flow, per golden transcript, per provider. Never across
// providers: claude and codex legitimately differ in tool vocabulary, session
// plumbing, and blocked-item visibility, so a cross-agent compare would be
// meaningless.

import { describe, expect, it } from 'vitest'
import { createClaudeAdapter } from '../claude'
import { makeFlow as makeClaudeFlow } from './claude'
import { CLAUDE_GOLDENS } from './claude.goldens'
import { driveAdapter, applyEvents, forCompare } from './parity'
import { driveFlow, goldenInput, type Golden } from './testCtx'

const TASK_PROMPT = 'Prompt: {{forwardable}}.'
const LANDER_BIN = '/repo/bin/lander'
// A stub snapshot, so the compare depends on neither the host's git tree nor the
// clock. Both paths get the same one.
const GIT_STUB = () => 'GIT-SNAPSHOT-STUB'
const MINTED = 'minted-session-id'

function claudeAdapters() {
  return {
    claude: createClaudeAdapter({
      landerBin: LANDER_BIN,
      taskPromptTemplate: TASK_PROMPT,
      readGitContext: GIT_STUB,
    }),
  }
}

function claudeFlow() {
  return makeClaudeFlow({
    landerBin: LANDER_BIN,
    taskPromptTemplate: TASK_PROMPT,
    gitContext: GIT_STUB,
    mint: () => MINTED,
  })
}

async function bothPaths(g: Golden) {
  const oracle = await driveAdapter(g, claudeAdapters(), () => MINTED)
  const flow = await driveFlow(g, claudeFlow())
  return {
    oracle,
    flow: {
      ...flow,
      task: applyEvents(goldenInput(g).start, flow.events),
    },
  }
}

// Updates carry the whole comparable wire payload; session/turn-context and
// state-patch are the two paths' legitimately different plumbing for the SAME
// facts, which the folded task state is what actually compares.
const updatesOf = (events: { kind: string }[]) =>
  events.filter((e) => e.kind === 'update')

describe('claude parity — adapter oracle vs ported flow', () => {
  for (const g of CLAUDE_GOLDENS) {
    describe(g.name, () => {
      it('folds to the same task state', async () => {
        const { oracle, flow } = await bothPaths(g)
        expect(forCompare(flow.task)).toEqual(forCompare(oracle.task))
      })

      it('produces the same wire update sequence', async () => {
        const { oracle, flow } = await bothPaths(g)
        // Tighter than the folded compare: catches streaming-granularity drift
        // and identity-translation slips before the fold hides them.
        expect(updatesOf(flow.events)).toEqual(updatesOf(oracle.events))
      })

      it('launches the child identically', async () => {
        const { oracle, flow } = await bothPaths(g)
        // Task-JSON and wire equality are blind to the launch — a dropped
        // --settings, acceptEdits, or --add-dir would pass both and fail live.
        expect(
          flow.spawns.map((s) => ({
            command: s.command,
            args: s.args,
            cwd: s.cwd,
            envDelta: s.envDelta,
          })),
        ).toEqual(
          oracle.spawns.map((s) => ({
            command: s.command,
            args: s.args,
            cwd: s.cwd,
            envDelta: s.envDelta,
          })),
        )
      })

      it('reports the same turn outcome', async () => {
        const { oracle, flow } = await bothPaths(g)
        const doneOf = (events: { kind: string }[]) =>
          events.find((e) => e.kind === 'done')
        expect(doneOf(flow.events)).toEqual(doneOf(oracle.events))
      })
    })
  }
})

describe('claude parity — thread identity across the two plumbings', () => {
  it('resumes a legacy top-level session rather than minting a fresh one', async () => {
    // The bug this exists to catch is silent: the flow would mint, the
    // conversation would restart with no error anywhere, and the correct id
    // would have ridden in unused on the wire.
    const g = CLAUDE_GOLDENS.find(
      (x) => x.name === 'legacy top-level session resumes without minting',
    )!
    const flow = await driveFlow(g, claudeFlow())
    const args = flow.spawns[0].args
    expect(args.slice(0, 2)).toEqual(['--resume', 'sess-legacy-only'])
    expect(args).not.toContain('--session-id')
    expect(args).not.toContain(MINTED)
  })

  it('lands a second ride’s state write above the server’s dedupe guard', async () => {
    const g = CLAUDE_GOLDENS.find(
      (x) => x.name === 'second ride seeded with a nonzero flowStateRev',
    )!
    const flow = await driveFlow(g, claudeFlow())
    const task = applyEvents(goldenInput(g).start, flow.events) as {
      flowState?: Record<string, unknown>
      flowStateRev?: number
    }
    // Seeded at 6; a producer restarting at 1 would have every batch dropped.
    expect(task.flowStateRev).toBeGreaterThan(6)
    expect(task.flowState?.sessionId).toBe(MINTED)
    // The pre-existing state survives the write rather than being replaced.
    expect(task.flowState?.phase).toBe('reviewing')
  })

  it('mints and persists a session for a fresh task', async () => {
    const g = CLAUDE_GOLDENS[0]
    const flow = await driveFlow(g, claudeFlow())
    const task = applyEvents(goldenInput(g).start, flow.events) as {
      flowState?: Record<string, unknown>
    }
    expect(task.flowState?.sessionId).toBe(MINTED)
    expect(flow.spawns[0].args.slice(0, 2)).toEqual(['--session-id', MINTED])
  })

  it('does not re-send an unchanged turn context', async () => {
    const g = CLAUDE_GOLDENS.find(
      (x) => x.name === 'unchanged turn context is not re-sent',
    )!
    const flow = await driveFlow(g, claudeFlow())
    expect(flow.spawns[0].args.at(-1)).toBe('do the thing')
  })

  it('always sends the full context block when it mints a fresh session', async () => {
    // flowState rides in ungated and a replayed patch can outlive a seal, so a
    // stale baseline must never be able to suppress a new session's context.
    const g: Golden = {
      name: 'fresh session with a stale baseline',
      chunks: [['{"type":"system","subtype":"init","model":"m"}']],
      start: { flowState: { turnContext: 'GIT-SNAPSHOT-STUB-stale' } },
    }
    const flow = await driveFlow(g, claudeFlow())
    expect(flow.spawns[0].args.at(-1)).toContain('<task-context>')
  })
})

describe('claude parity — the flush cadence', () => {
  it('emits one update per stdout chunk, not per line', async () => {
    const g = CLAUDE_GOLDENS.find(
      (x) => x.name === 'single tool call and result in one chunk',
    )!
    const flow = await driveFlow(g, claudeFlow())
    const oracle = await driveAdapter(g, claudeAdapters(), () => MINTED)
    // The first chunk holds three lines and must still be one update. A runtime
    // that flushed per line would pass a line-fed golden and be chattier live.
    expect(updatesOf(flow.events).length).toBe(updatesOf(oracle.events).length)
    expect(updatesOf(flow.events).length).toBeLessThan(g.chunks.flat().length)
  })
})
