// The open-PR flow's decision logic, driven against the real ctx runtime with
// fake edges (spawn, fetch). It has no compiled adapter and so no parity
// oracle — the parity harness is per-provider old-vs-new and correctly doesn't
// cover it — so these are its only coverage.

import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { StartRunMessage } from '../../server/protocol'
import type { HostEvent, HostInput } from '../run-agent'
import { createCtxRuntime } from './ctx'
import {
  classifyChecks,
  findOwnAsk,
  firstPrNumber,
  makeFlow,
  parsePrNumberFromUrl,
  resolveLaunchDir,
  scriptedCheck,
} from './open-pr'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn(() => true)
}

function makeInput(
  flowState: Record<string, unknown> = {},
  flowConfig: Record<string, unknown> = {},
  allowEdits = true,
): HostInput {
  const start: StartRunMessage = {
    type: 'start-run',
    runId: 'ride-1',
    taskId: 'task-1',
    flow: 'open-pr',
    project: 'proj',
    prompt: 'go',
    task: { allowEdits },
    env: {
      LANDER_API: 'http://api.test',
      LANDER_PROJECT: 'proj',
      LANDER_TASK: 'task-1',
      LANDER_TOKEN: 'tok',
    },
    idleTimeoutMs: 600_000,
    flowState,
    flowConfig,
  }
  return { start, root: '/repo', cwd: '/repo' }
}

// Drive one ride. `outputs` answers each spawn in order; `view` is what
// ctx.view() returns.
async function ride({
  flowState = {},
  flowConfig = { dryRun: true },
  outputs = [],
  view = { items: [] },
  allowEdits = true,
}: {
  flowState?: Record<string, unknown>
  flowConfig?: Record<string, unknown>
  outputs?: { out?: string; code?: number }[]
  view?: unknown
  allowEdits?: boolean
} = {}) {
  const events: HostEvent[] = []
  const spawned: { command: string; args: string[] }[] = []
  const requests: { url: string; method: string; body: unknown }[] = []
  let n = 0

  const spawn = (command: string, args: string[], _o: SpawnOptions) => {
    const child = new FakeChild()
    spawned.push({ command, args })
    const reply = outputs[n++] ?? { out: '', code: 0 }
    queueMicrotask(() => {
      if (reply.out) child.stdout.emit('data', Buffer.from(reply.out + '\n'))
      child.stdout.emit('end')
      child.emit('close', reply.code ?? 0)
    })
    return child as unknown as ChildProcess
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method ?? 'GET',
        body:
          typeof init?.body === 'string'
            ? JSON.parse(init.body)
            : init?.body instanceof FormData
              ? Object.fromEntries(
                  [...init.body.entries()].map(([k, v]) => [
                    k,
                    typeof v === 'string' ? v : '<blob>',
                  ]),
                )
              : undefined,
      })
      // apiCall defaults the method to 'GET', so it is never undefined here.
      const isView =
        (init?.method ?? 'GET') === 'GET' && url.endsWith('/tasks/task-1')
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () =>
          isView ? view : { ask: { id: 'ask-new' }, id: 'sibling-1' },
        text: async () => '',
      } as Response
    }),
  )

  try {
    const runtime = createCtxRuntime(makeInput(flowState, flowConfig, allowEdits), {
      emit: (e) => events.push(e),
      now: () => '2026-01-01T00:00:00.000Z',
      spawn,
    })
    await runtime.runTurn(makeFlow())
  } finally {
    vi.unstubAllGlobals()
  }

  const ops = events.flatMap((e) => (e.kind === 'state-patch' ? e.ops : []))
  const stateAfter: Record<string, unknown> = { ...flowState }
  for (const op of ops)
    if (op.path.length === 1) {
      if (op.op === 'set') stateAfter[op.path[0]] = op.value
      if (op.op === 'push')
        stateAfter[op.path[0]] = [
          ...((stateAfter[op.path[0]] as unknown[]) ?? []),
          op.value,
        ]
    }
  const text = JSON.stringify(events)
  return { events, spawned, requests, ops, stateAfter, text }
}

const ask = (over: Record<string, unknown> = {}) => ({
  id: 'ask-1',
  kind: 'ask',
  blocking: 'task',
  state: 'answered',
  ...over,
})

describe('findOwnAsk', () => {
  it('ignores platform retry asks', () => {
    // Round 3's sharpest finding, and C11's live walk will not naturally
    // produce a retry ask — so without this the fix is unverified.
    //
    // A platform retry ask is ALSO blocking:'task' and is appended AFTER the
    // flow's own. Selecting "the last task-blocking ask" would pick it: a
    // failed `git push` exits non-zero while riding, applyDone raises the retry
    // ask, the user clicks "Try again", and the flow reads optionId
    // 'retry-now' — matching no branch, silently discarding a real approval.
    const view = {
      items: [
        ask({ id: 'mine', answer: { optionId: 'open-pr' } }),
        ask({ id: 'platform', origin: 'retry', answer: { optionId: 'retry-now' } }),
      ],
    }
    expect(findOwnAsk(view, 'task')?.id).toBe('mine')
  })

  it('takes the LAST of the flow’s own asks at that blocking level', () => {
    const view = {
      items: [
        ask({ id: 'old', answer: { optionId: 'cancel' } }),
        ask({ id: 'new', answer: { optionId: 'open-pr' } }),
      ],
    }
    expect(findOwnAsk(view, 'task')?.id).toBe('new')
  })

  it('separates advisory from task-blocking asks', () => {
    const view = {
      items: [
        ask({ id: 'blocking', blocking: 'task' }),
        ask({ id: 'advisory', blocking: 'none' }),
      ],
    }
    expect(findOwnAsk(view, 'task')?.id).toBe('blocking')
    expect(findOwnAsk(view, 'none')?.id).toBe('advisory')
  })

  it('returns nothing when the log holds only platform asks', () => {
    expect(findOwnAsk({ items: [ask({ origin: 'retry' })] }, 'task')).toBeUndefined()
  })
})

describe('open-pr — collect', () => {
  it('writes artifacts and wedges for approval, phase-first', async () => {
    const r = await ride({
      outputs: [
        { out: 'feature-x' }, // rev-parse
        { out: ' M src/a.ts' }, // status
        { out: 'diff --git a/src/a.ts' }, // diff
        { out: 'abc1234 do a thing' }, // log
      ],
    })
    expect(r.stateAfter.phase).toBe('awaiting-approval')
    expect(r.stateAfter.branch).toBe('feature-x')
    // Both artifacts, then the wedge.
    const posts = r.requests.filter((q) => q.method === 'POST')
    expect(posts.filter((q) => q.url.includes('/artifacts'))).toHaveLength(2)
    const wedge = posts.find((q) => q.url.endsWith('/asks'))
    expect(wedge?.body).toMatchObject({ blocking: 'task' })
    expect(JSON.stringify(wedge?.body)).toContain('open-pr')
  })

  it('stops early on a clean tree without asking anything', async () => {
    const r = await ride({
      outputs: [{ out: 'main' }, { out: '' }, { out: '' }, { out: '' }],
    })
    expect(r.requests.some((q) => q.url.endsWith('/asks'))).toBe(false)
    expect(r.text).toContain('clean')
  })
})

describe('open-pr — awaiting-approval', () => {
  it('continues into push in the SAME ride when approved', async () => {
    const r = await ride({
      flowState: { phase: 'awaiting-approval', branch: 'feature-x' },
      view: { items: [ask({ answer: { optionId: 'open-pr' } })] },
      outputs: [{ out: '' }, { out: '[]' }],
    })
    // It reached push and rested — no second user message required.
    expect(r.stateAfter.phase).toBe('watch')
    expect(r.requests.some((q) => q.url.endsWith('/rest'))).toBe(true)
  })

  it('stops on cancel', async () => {
    const r = await ride({
      flowState: { phase: 'awaiting-approval', branch: 'feature-x' },
      view: { items: [ask({ answer: { optionId: 'cancel' } })] },
    })
    expect(r.text).toContain('Cancelled')
    expect(r.spawned).toHaveLength(0)
  })

  it('treats a withdrawn ask as superseded and re-collects in the same ride', async () => {
    const r = await ride({
      flowState: { phase: 'awaiting-approval', branch: 'feature-x' },
      view: { items: [ask({ state: 'withdrawn' })] },
      outputs: [{ out: 'feature-x' }, { out: ' M a' }, { out: 'diff' }, { out: 'log' }],
    })
    expect(r.text).toContain('superseded')
    // Re-collected rather than swallowing the user's message.
    expect(r.spawned.length).toBeGreaterThan(0)
    expect(r.stateAfter.phase).toBe('awaiting-approval')
  })

  it('treats an unrecognized optionId as superseded, not as an unhandled case', async () => {
    // What makes the branch set total: a platform 'retry-now' that somehow
    // reached here must not fall through silently.
    const r = await ride({
      flowState: { phase: 'awaiting-approval', branch: 'feature-x' },
      view: { items: [ask({ answer: { optionId: 'retry-now' } })] },
      outputs: [{ out: 'feature-x' }, { out: ' M a' }, { out: 'diff' }, { out: 'log' }],
    })
    expect(r.text).toContain('superseded')
  })
})

describe('open-pr — push idempotency', () => {
  it('skips the push when the branch is already on origin', async () => {
    const r = await ride({
      flowState: { phase: 'push', branch: 'feature-x' },
      outputs: [
        { out: 'abc123\trefs/heads/feature-x' }, // ls-remote finds it
        { out: '[]' }, // no existing PR
      ],
    })
    expect(r.text).toContain('already on origin')
    // Only the two probes ran; no push.
    expect(r.spawned.map((s) => s.args[0])).toEqual(['ls-remote', 'pr'])
  })

  it('reuses an existing PR instead of creating a second one', async () => {
    const r = await ride({
      flowState: { phase: 'push', branch: 'feature-x' },
      outputs: [{ out: 'abc\trefs/heads/feature-x' }, { out: '[{"number":42}]' }],
    })
    expect(r.stateAfter.prNumber).toBe(42)
    expect(r.text).toContain('already exists')
  })

  it('emits the exact argv without running it in dry-run', async () => {
    const r = await ride({
      flowState: { phase: 'push', branch: 'feature-x' },
      outputs: [{ out: '' }, { out: '[]' }],
    })
    // The mutating commands never spawned — only the two probes did.
    expect(r.spawned.map((s) => s.args[0])).toEqual(['ls-remote', 'pr'])
    expect(r.text).toContain('git push -u origin feature-x')
    expect(r.text).toContain('gh pr create --head feature-x --fill')
    expect(r.text).toContain('dry-run')
  })
})

describe('open-pr — watch', () => {
  it('rests again while pending, and raises the advisory ask once', async () => {
    const r = await ride({
      flowState: { phase: 'watch', prNumber: 9999, attempts: 0 },
    })
    expect(r.stateAfter.attempts).toBe(1)
    const asks = r.requests.filter((q) => q.url.endsWith('/asks'))
    expect(asks).toHaveLength(1)
    expect(asks[0].body).toMatchObject({ blocking: 'none' })
    expect(r.requests.some((q) => q.url.endsWith('/rest'))).toBe(true)
  })

  it('consumes an advisory answer exactly once', async () => {
    // Without the consumption rule the answer is re-read on every wakeup, so
    // "Keep watching" would reset the counter forever — defeating both the
    // attempt bound and the noise budget that bound protects.
    const advisory = ask({
      id: 'adv-1',
      blocking: 'none',
      answer: { optionId: 'keep-watching' },
    })
    const pending = { dryRun: true, dryRunOutcome: 'pending' }
    const first = await ride({
      flowState: { phase: 'watch', prNumber: 9999, attempts: 5 },
      flowConfig: pending,
      view: { items: [advisory] },
    })
    expect(first.stateAfter.consumedAsks).toEqual(['adv-1'])
    expect(first.stateAfter.attempts).toBe(1) // reset, then this pending attempt

    // Same answered ask, now already consumed: the counter must keep climbing.
    const second = await ride({
      flowState: {
        phase: 'watch',
        prNumber: 9999,
        attempts: 5,
        consumedAsks: ['adv-1'],
      },
      flowConfig: pending,
      view: { items: [advisory] },
    })
    expect(second.stateAfter.attempts).toBe(6)
  })

  it('stops when the advisory ask says stop', async () => {
    const r = await ride({
      flowState: { phase: 'watch', prNumber: 9999, attempts: 1 },
      view: {
        items: [
          ask({ id: 'adv', blocking: 'none', answer: { optionId: 'stop-watching' } }),
        ],
      },
    })
    expect(r.text).toContain('Stopped watching')
    expect(r.requests.some((q) => q.url.endsWith('/rest'))).toBe(false)
  })

  it('walks the scripted failure branch: artifact, sibling launch, wedge', async () => {
    const r = await ride({
      flowState: { phase: 'watch', prNumber: 9999, attempts: 2 },
      flowConfig: { dryRun: true, dryRunOutcome: 'failed' },
    })
    expect(r.requests.some((q) => q.url.includes('/artifacts'))).toBe(true)
    const launch = r.requests.find(
      (q) => q.method === 'POST' && q.url.endsWith('/api/proj/tasks'),
    )
    expect(launch).toBeDefined()
    expect(JSON.stringify(launch?.body)).toContain('9999')
    expect(r.stateAfter.repairTask).toBe('sibling-1')
    const wedge = r.requests.filter((q) => q.url.endsWith('/asks'))
    expect(wedge[wedge.length - 1].body).toMatchObject({ blocking: 'task' })
  })

  it('forwards only the edit access it actually holds to the repair sibling', async () => {
    // Found live, not by unit test: the server REJECTS a launch asking for more
    // edit access than the spawner holds, so an unconditional `edits: true`
    // failed the entire turn for a read-only open-pr task — the dry run died
    // with "spawning task lacks edit permission to pass on" and surfaced a
    // platform retry ask instead of the repair sibling.
    const readOnly = await ride({
      flowState: { phase: 'watch', prNumber: 9999, attempts: 2 },
      flowConfig: { dryRun: true, dryRunOutcome: 'failed' },
      allowEdits: false,
    })
    const launch = readOnly.requests.find(
      (q) => q.method === 'POST' && q.url.endsWith('/api/proj/tasks'),
    )
    expect(launch?.body).toMatchObject({ allowEdits: false })
    // And it still completes the branch rather than throwing.
    expect(readOnly.stateAfter.repairTask).toBe('sibling-1')

    const withEdits = await ride({
      flowState: { phase: 'watch', prNumber: 9999, attempts: 2 },
      flowConfig: { dryRun: true, dryRunOutcome: 'failed' },
      allowEdits: true,
    })
    expect(
      withEdits.requests.find(
        (q) => q.method === 'POST' && q.url.endsWith('/api/proj/tasks'),
      )?.body,
    ).toMatchObject({ allowEdits: true })
  })

  it('walks the scripted success branch', async () => {
    const r = await ride({
      flowState: { phase: 'watch', prNumber: 9999, attempts: 1 },
      flowConfig: { dryRun: true, dryRunOutcome: 'passed' },
    })
    expect(r.text).toContain('Checks passed')
    expect(r.requests.some((q) => q.url.endsWith('/rest'))).toBe(false)
  })

  it('gives up at the attempt bound instead of resting forever', async () => {
    // 'pending' never resolves, which is what makes the bound reachable here.
    const r = await ride({
      flowState: { phase: 'watch', prNumber: 9999, attempts: 11 },
      flowConfig: { dryRun: true, dryRunOutcome: 'pending' },
    })
    expect(r.text).toContain('stopped watching')
    expect(r.requests.some((q) => q.url.endsWith('/rest'))).toBe(false)
  })
})

describe('open-pr — dry-run is fail-safe', () => {
  it('treats anything but the literal boolean false as dry-run', async () => {
    // flowConfig values arrive from --key argv through JSON.parse, so a
    // mis-coerced string must never enable pushing.
    for (const dryRun of ['false', 0, null, undefined, 'no']) {
      const r = await ride({
        flowState: { phase: 'push', branch: 'b' },
        flowConfig: { dryRun },
        outputs: [{ out: '' }, { out: '[]' }],
      })
      expect(r.spawned.map((s) => s.args[0])).toEqual(['ls-remote', 'pr'])
      expect(r.text).toContain('dry-run')
    }
  })

  it('only the literal false actually runs the mutating commands', async () => {
    const r = await ride({
      flowState: { phase: 'push', branch: 'b' },
      flowConfig: { dryRun: false },
      outputs: [
        { out: '' }, // ls-remote: not on origin
        { out: '' }, // git push
        { out: '[]' }, // gh pr list
        { out: 'https://github.com/o/r/pull/7' }, // gh pr create
      ],
    })
    expect(r.spawned.map((s) => s.args[0])).toEqual(['ls-remote', 'push', 'pr', 'pr'])
    expect(r.stateAfter.prNumber).toBe(7)
  })
})

describe('open-pr — helpers', () => {
  it('parses PR numbers from gh json and from a created URL', () => {
    expect(firstPrNumber('[{"number":42}]')).toBe(42)
    expect(firstPrNumber('[]')).toBeUndefined()
    expect(firstPrNumber('not json')).toBeUndefined()
    expect(parsePrNumberFromUrl('https://github.com/o/r/pull/7')).toBe(7)
    expect(parsePrNumberFromUrl('nothing here')).toBeUndefined()
  })

  it('classifies check output, preferring pending over a nonzero exit', () => {
    expect(classifyChecks({ out: 'build\tpending', code: 1 })).toBe('pending')
    expect(classifyChecks({ out: 'build\tfail', code: 1 })).toBe('failed')
    expect(classifyChecks({ out: 'build\tpass', code: 0 })).toBe('passed')
    expect(classifyChecks({ out: '', code: 1 })).toBe('failed')
  })

  it('scripts both dry-run outcomes through a pending phase', () => {
    expect(scriptedCheck(0, 'passed')).toBe('pending')
    expect(scriptedCheck(1, 'passed')).toBe('passed')
    expect(scriptedCheck(0, 'failed')).toBe('pending')
    expect(scriptedCheck(1, 'failed')).toBe('pending')
    expect(scriptedCheck(2, 'failed')).toBe('failed')
  })

  it('launches into the recorded cwd with no re-entry argv', () => {
    expect(
      resolveLaunchDir({ root: '/repo', recordedCwd: '/repo/sub', isDir: () => true }),
    ).toEqual({ cwd: '/repo/sub', reentryArgs: [] })
    expect(
      resolveLaunchDir({ root: '/repo', recordedCwd: '/gone', isDir: () => false }),
    ).toEqual({ cwd: '/repo', reentryArgs: [] })
  })
})
