// Old adapter vs new flow, per golden transcript, per provider. Never across
// providers: claude and codex legitimately differ in tool vocabulary, session
// plumbing, and blocked-item visibility, so a cross-agent compare would be
// meaningless.

import { describe, expect, it } from 'vitest'
import { createClaudeAdapter } from '../claude'
import { createCodexAdapter } from '../codex'
import { makeFlow as makeClaudeFlow } from './claude'
import { makeFlow as makeCodexFlow } from './codex'
import { CLAUDE_GOLDENS } from './claude.goldens'
import { CODEX_GOLDENS } from './codex.goldens'
import type { HostEvent } from '../run-agent'
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

// A stub git-common-dir probe, so codex's permission profile doesn't depend on
// the host's repo layout.
const GIT_COMMON_STUB = () => '/repo/.git'

function codexAdapters() {
  return {
    codex: createCodexAdapter({
      taskPromptTemplate: TASK_PROMPT,
      resolveGitCommonDir: GIT_COMMON_STUB,
    }),
  }
}

function codexFlow() {
  return makeCodexFlow({
    taskPromptTemplate: TASK_PROMPT,
    resolveGitCommonDir: GIT_COMMON_STUB,
  })
}

async function bothPaths(
  g: Golden,
  adapters: Parameters<typeof driveAdapter>[1],
  flowUnderTest: Parameters<typeof driveFlow>[1],
) {
  const oracle = await driveAdapter(g, adapters, () => MINTED)
  const flow = await driveFlow(g, flowUnderTest)
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
const updatesOf = (events: HostEvent[]) =>
  events.filter(
    (e): e is Extract<HostEvent, { kind: 'update' }> => e.kind === 'update',
  )

const launchOf = (spawns: { command: string; args: string[]; cwd?: string; envDelta: Record<string, string> }[]) =>
  spawns.map((s) => ({
    command: s.command,
    args: s.args,
    cwd: s.cwd,
    envDelta: s.envDelta,
  }))

const doneOf = (events: HostEvent[]) => events.find((e) => e.kind === 'done')

// Parity is per provider, never across them.
function parityFor(
  label: string,
  goldens: Golden[],
  adapters: Parameters<typeof driveAdapter>[1],
  flowUnderTest: Parameters<typeof driveFlow>[1],
) {
  describe(`${label} parity — adapter oracle vs ported flow`, () => {
    for (const g of goldens) {
      describe(g.name, () => {
        it('folds to the same task state', async () => {
          const { oracle, flow } = await bothPaths(g, adapters, flowUnderTest)
          expect(forCompare(flow.task)).toEqual(forCompare(oracle.task))
        })

        it('produces the same wire update sequence', async () => {
          const { oracle, flow } = await bothPaths(g, adapters, flowUnderTest)
          // Tighter than the folded compare: catches streaming-granularity drift
          // and identity-translation slips before the fold hides them.
          expect(updatesOf(flow.events)).toEqual(updatesOf(oracle.events))
        })

        it('launches the child identically', async () => {
          const { oracle, flow } = await bothPaths(g, adapters, flowUnderTest)
          // Task-JSON and wire equality are blind to the launch — a dropped
          // --settings, acceptEdits, --add-dir, permission profile, or a
          // misplaced -i would pass both and fail only live.
          expect(launchOf(flow.spawns)).toEqual(launchOf(oracle.spawns))
        })

        it('reports the same turn outcome', async () => {
          const { oracle, flow } = await bothPaths(g, adapters, flowUnderTest)
          expect(doneOf(flow.events)).toEqual(doneOf(oracle.events))
        })
      })
    }
  })
}

parityFor('claude', CLAUDE_GOLDENS, claudeAdapters(), claudeFlow())
parityFor('codex', CODEX_GOLDENS, codexAdapters(), codexFlow())

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

describe('codex parity — session and identity', () => {
  it('writes no session patch when a resumed turn re-emits thread.started', async () => {
    // The adapter's `!sessionId && !announced` guard: a resumed turn re-emits
    // the event, and persisting it again would put a state-patch on the wire
    // that the oracle never sends.
    const g = CODEX_GOLDENS.find(
      (x) =>
        x.name ===
        'resumed turn re-emitting thread.started writes no duplicate session',
    )!
    const flow = await driveFlow(g, codexFlow())
    expect(flow.events.filter((e) => e.kind === 'state-patch')).toEqual([])
  })

  it('persists the thread id the stream reports on a fresh turn', async () => {
    const g = CODEX_GOLDENS[0]
    const flow = await driveFlow(g, codexFlow())
    const task = applyEvents(goldenInput(g).start, flow.events) as {
      flowState?: Record<string, unknown>
    }
    expect(task.flowState?.sessionId).toBe('thread-1')
  })

  it('keeps two rides that reuse the same local item ids distinct', async () => {
    const first = CODEX_GOLDENS.find(
      (x) => x.name === 'command execution started and completed in one chunk',
    )!
    const second = CODEX_GOLDENS.find(
      (x) => x.name === 'later ride reusing the same local item ids',
    )!
    const a = await driveFlow(first, codexFlow())
    const b = await driveFlow(second, codexFlow())
    const idsOf = (r: typeof a) =>
      updatesOf(r.events).flatMap((u) => u.steps.map((s) => s.toolUseId))
    // Both streams call their command `item-1`; the runtime's per-run minting is
    // what stops the second ride folding onto the first ride's item.
    const overlap = idsOf(a).filter((id) => id && idsOf(b).includes(id))
    expect(overlap).toEqual([])
  })

  it('reports no project-grant support, with a reason to show the user', async () => {
    const { meta } = codexFlow()
    expect(meta.capabilities.grants).toEqual({ task: false, project: false })
    expect(meta.projectGrantsUnsupportedReason).toBe(
      'Project permission grants are not supported for Codex tasks yet.',
    )
  })
})

// Parity proves the two paths agree; these prove they agree on the right thing —
// the notice actually reaches the child, as a prompt part rather than as part of
// the delta-compared context block.
describe('the revival notice reaches the prompt', () => {
  // Not `args.at(-1)`: codex puts a fresh `exec`'s flags AFTER the positional
  // prompt (its variadic --image would otherwise swallow it).
  const promptOf = (args: string[]) =>
    args.find((a) => a.includes('do the thing')) as string

  it('rides claude’s prompt, outside the task-context block', async () => {
    const g = CLAUDE_GOLDENS.find(
      (x) => x.name === 'revival notice rides the prompt of the reviving turn',
    )!
    const flow = await driveFlow(g, claudeFlow())
    const prompt = promptOf(flow.spawns[0].args)
    expect(prompt).toContain(
      '<task-revived>\nYou were wedged when this message arrived; the message ' +
        'changed your status to riding.\n</task-revived>',
    )
    // Not inside the context block: that block is compared against a stored
    // baseline, so a one-turn line in it costs a spurious resend next turn.
    expect(
      prompt.slice(prompt.indexOf('<task-context>')),
    ).not.toContain('<task-revived>')
  })

  it('rides codex’s prompt, which has no context block at all', async () => {
    const g = CODEX_GOLDENS.find(
      (x) => x.name === 'revival notice rides the prompt of the reviving turn',
    )!
    const flow = await driveFlow(g, codexFlow())
    expect(promptOf(flow.spawns[0].args)).toContain(
      '<task-revived>\nYou were landed when this message arrived; the message ' +
        'changed your status to riding.\n</task-revived>',
    )
  })

  // The cleared-timer half travels the same wire as the wedged/landed half, so
  // this is really about the marker being an object now: an early revival that
  // crossed no notable status still has something to say.
  it('carries a cleared rest timer, with the time and the way back', async () => {
    const g = CLAUDE_GOLDENS.find(
      (x) => x.name === 'revival notice names a cleared rest timer',
    )!
    const flow = await driveFlow(g, claudeFlow())
    expect(promptOf(flow.spawns[0].args)).toContain(
      '<task-revived>\nYou were resting until 3:00:00 PM when this message ' +
        'arrived; the message changed your status to riding and cleared that ' +
        'wakeup. Re-arm it with `lander rest` if you still want it.\n' +
        '</task-revived>',
    )
  })

  it('is absent from a turn that did not revive anything', async () => {
    const flow = await driveFlow(CLAUDE_GOLDENS[0], claudeFlow())
    expect(promptOf(flow.spawns[0].args)).not.toContain('<task-revived>')
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
