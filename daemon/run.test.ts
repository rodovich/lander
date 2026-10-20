import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StartRunMessage } from '../server/protocol'
import type { HostEvent, HostInput } from './host-protocol'
import {
  createRunManager,
  type RunManagerMessage,
  type RunManagerOptions,
} from './run'
import { providerCaps } from './flows/index'

// A stand-in for the flow-host subprocess. Its stdin captures the HostInput the
// daemon writes; its stdout/stderr are pushed by the test to drive the supervisor;
// `kill` records the group-kill (pid is undefined here, so killHost falls back to
// the plain kill this mock records — no real process group is signaled in a test).
class FakeHost extends EventEmitter {
  pid: number | undefined = undefined
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = {
    writes: [] as string[],
    write(chunk: string) {
      this.writes.push(String(chunk))
      return true
    },
    end(chunk?: string) {
      if (chunk !== undefined) this.writes.push(String(chunk))
    },
    on() {},
  }
  kill = vi.fn(() => true)
}

function makeStart(over: Partial<StartRunMessage> = {}): StartRunMessage {
  return {
    type: 'start-run',
    runId: 'run-1',
    taskId: 'task-1',
    agent: 'codex',
    project: 'proj',
    prompt: 'prompt',
    task: {},
    env: { LANDER_TASK: 'task-1' },
    idleTimeoutMs: 60_000,
    ...over,
  }
}

function harness(opts: Partial<RunManagerOptions> = {}) {
  const messages: RunManagerMessage[] = []
  const hosts: FakeHost[] = []
  const spawnHost = () => {
    const host = new FakeHost()
    hosts.push(host)
    return host as unknown as ChildProcess
  }
  const manager = createRunManager({
    // Use the same flow capabilities as the live supervisor.
    caps: providerCaps(),
    resolveRunPaths: () => ({ root: '/repo', cwd: '/repo', reentryArgs: [] }),
    send: (msg) => messages.push(msg),
    resolveFilesDir: (msg) => `/files/${msg.project}/${msg.taskId}`,
    refreshUsage: () => {},
    spawnHost,
    ...opts,
  })
  return { manager, messages, hosts }
}

// Push one neutral host event on the fake host's stdout, framed as line-JSON — the
// same wire the real host writes.
function push(host: FakeHost, event: HostEvent): void {
  host.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'))
}

// The HostInput the daemon wrote to the host's stdin.
function hostInputOf(host: FakeHost): HostInput {
  return JSON.parse(host.stdin.writes.join('').trim()) as HostInput
}

describe('daemon run manager', () => {
  it('assigns seq and relays host events as run-manager messages', () => {
    const h = harness()
    h.manager.startRun(makeStart())
    const host = h.hosts[0]

    push(host, { kind: 'session', sessionId: 'sess-x' })
    push(host, {
      kind: 'update',
      steps: [{ kind: 'text', text: 'hi', createdAt: 't' }],
      finalText: 'hi',
      blockedIds: [],
      usageChanged: false,
    })
    push(host, { kind: 'done', exitCode: 0, stderr: '' })

    expect(h.messages.map((m) => m.type)).toEqual(['session', 'update', 'done'])
    expect(h.messages[0]).toMatchObject({
      type: 'session',
      runId: 'run-1',
      sessionId: 'sess-x',
    })
    expect(h.messages[1]).toMatchObject({
      type: 'update',
      runId: 'run-1',
      seq: 1,
      finalText: 'hi',
    })
    expect(h.messages[2]).toMatchObject({
      type: 'done',
      runId: 'run-1',
      exitCode: 0,
      interrupted: false,
      stderr: '',
    })
  })

  it('hands the host a HostInput with the resolved paths and start fields', async () => {
    const h = harness({
      materialize: async () => ({
        filesDir: '/mat',
        manifestBlock: '<task-attachments>\n…\n</task-attachments>',
      }),
    })

    h.manager.startRun(
      makeStart({
        agent: 'codex',
        prompt: 'look',
        attachments: [{ id: 'img1', name: 'p.png', mime: 'image/png', size: 2 }],
      }),
    )
    // Materialization is async: no host spawns on the same tick.
    expect(h.hosts).toHaveLength(0)
    await vi.waitFor(() => expect(h.hosts).toHaveLength(1))

    const input = hostInputOf(h.hosts[0])
    expect(input.start).toMatchObject({
      runId: 'run-1',
      agent: 'codex',
      prompt: 'look',
    })
    expect(input.root).toBe('/repo')
    expect(input.cwd).toBe('/repo')
    // The persistent per-task store dir wins over the just-materialized one.
    expect(input.filesDir).toBe('/files/proj/task-1')
    expect(input.materialized).toMatchObject({ manifestBlock: '<task-attachments>\n…\n</task-attachments>' })
  })

  it('sets the files dir in the HostInput on a turn carrying no attachments', () => {
    const h = harness()
    h.manager.startRun(makeStart({ agent: 'codex' }))
    expect(h.hosts).toHaveLength(1)
    expect(hostInputOf(h.hosts[0]).filesDir).toBe('/files/proj/task-1')
  })

  it('interrupts by stopping the host and emitting an interrupted done once it exits', () => {
    const h = harness()
    h.manager.startRun(makeStart())
    const host = h.hosts[0]

    h.manager.interrupt('run-1')

    expect(host.kill).toHaveBeenCalledWith('SIGTERM')
    expect(host.kill).not.toHaveBeenCalledWith('SIGKILL')
    expect(h.messages.some((m) => m.type === 'done')).toBe(false)

    // The flow may report its own done while the agent winds down; the
    // interrupt still decides how the run settles.
    push(host, { kind: 'done', exitCode: 143, stderr: '' })
    host.emit('close', 143)
    expect(h.messages.filter((m) => m.type === 'done')).toEqual([
      expect.objectContaining({
        type: 'done',
        runId: 'run-1',
        exitCode: 0,
        interrupted: true,
      }),
    ])
  })

  it('kills the host group when a stopped host does not exit in time', () => {
    vi.useFakeTimers()
    try {
      const h = harness({ stopGraceMs: 100 })
      h.manager.startRun(makeStart())
      const host = h.hosts[0]

      h.manager.interrupt('run-1')
      vi.advanceTimersByTime(99)
      expect(host.kill).not.toHaveBeenCalledWith('SIGKILL')
      vi.advanceTimersByTime(1)
      expect(host.kill).toHaveBeenCalledWith('SIGKILL')

      host.emit('close', 137)
      expect(h.messages.at(-1)).toMatchObject({ type: 'done', interrupted: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('idle-stops the host and synthesizes a non-interrupted failed done', () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      h.manager.startRun(makeStart({ idleTimeoutMs: 50 }))
      const host = h.hosts[0]

      vi.advanceTimersByTime(49)
      expect(host.kill).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(host.kill).toHaveBeenCalledWith('SIGTERM')

      // The killed host closes without ever emitting a natural done. The
      // synthesized done names the idle kill and the window that expired.
      host.emit('close', 137)
      expect(h.messages.at(-1)).toMatchObject({
        type: 'done',
        runId: 'run-1',
        exitCode: 1,
        interrupted: false,
        cause: 'idle-timeout',
        idleMs: 50,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  describe('a flow waiting on background work', () => {
    const MINUTE = 60_000
    const wait = (host: FakeHost, until: number | null) => push(host, { kind: 'waiting', until })

    it('stays silent until the flow’s deadline plus a grace period, then is stopped', () => {
      vi.useFakeTimers({ now: 0 })
      try {
        const h = harness()
        h.manager.startRun(makeStart({ idleTimeoutMs: 50 }))
        const host = h.hosts[0]
        wait(host, 10 * MINUTE)

        vi.advanceTimersByTime(12 * MINUTE - 1)
        expect(host.kill).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(host.kill).toHaveBeenCalledWith('SIGTERM')

        host.emit('close', 137)
        expect(h.messages.at(-1)).toMatchObject({ cause: 'idle-timeout', idleMs: 12 * MINUTE })
      } finally {
        vi.useRealTimers()
      }
    })

    it('returns to the idle window once the wait ends', () => {
      vi.useFakeTimers({ now: 0 })
      try {
        const h = harness()
        h.manager.startRun(makeStart({ idleTimeoutMs: 50 }))
        const host = h.hosts[0]
        wait(host, 10 * MINUTE)
        vi.advanceTimersByTime(5 * MINUTE)
        wait(host, null)

        vi.advanceTimersByTime(49)
        expect(host.kill).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(host.kill).toHaveBeenCalledWith('SIGTERM')
      } finally {
        vi.useRealTimers()
      }
    })

    it('keeps the idle window when it is longer than the wait', () => {
      vi.useFakeTimers({ now: 0 })
      try {
        const h = harness()
        h.manager.startRun(makeStart({ idleTimeoutMs: 15 * MINUTE }))
        const host = h.hosts[0]
        wait(host, MINUTE)

        vi.advanceTimersByTime(15 * MINUTE - 1)
        expect(host.kill).not.toHaveBeenCalled()
        vi.advanceTimersByTime(1)
        expect(host.kill).toHaveBeenCalledWith('SIGTERM')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // The run's working time (DoneMessage.durationMs). Measured around the flow
  // host, so these hold identically for every provider — the fake host below is
  // the only executor involved.
  describe('working time', () => {
    it('times a clean run from spawn to its last output', () => {
      vi.useFakeTimers()
      try {
        const h = harness()
        h.manager.startRun(makeStart())
        const host = h.hosts[0]

        vi.advanceTimersByTime(1_500)
        push(host, {
          kind: 'update',
          steps: [],
          usageChanged: false,
        } as HostEvent)
        vi.advanceTimersByTime(500)
        push(host, { kind: 'done', exitCode: 0, stderr: '' })

        expect(h.messages.at(-1)).toMatchObject({
          type: 'done',
          durationMs: 2_000,
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('stops the clock at the last output, not at an idle kill', () => {
      vi.useFakeTimers()
      try {
        const h = harness()
        h.manager.startRun(makeStart({ idleTimeoutMs: 60_000 }))
        const host = h.hosts[0]

        vi.advanceTimersByTime(5_000)
        push(host, {
          kind: 'update',
          steps: [],
          usageChanged: false,
        } as HostEvent)
        // Then it goes quiet, and the watchdog eventually kills it.
        vi.advanceTimersByTime(60_000)
        host.emit('close', 137)

        const done = h.messages.at(-1)
        expect(done).toMatchObject({ cause: 'idle-timeout', idleMs: 60_000 })
        // 5s of work, not the 65s the ride was open. Billing the idle window
        // would make the runs that did the least look like the longest.
        expect(done).toMatchObject({ durationMs: 5_000 })
      } finally {
        vi.useRealTimers()
      }
    })

    it('times an interrupted run up to its last output', () => {
      vi.useFakeTimers()
      try {
        const h = harness()
        h.manager.startRun(makeStart())
        const host = h.hosts[0]

        vi.advanceTimersByTime(3_000)
        push(host, {
          kind: 'update',
          steps: [],
          usageChanged: false,
        } as HostEvent)
        vi.advanceTimersByTime(10_000)
        h.manager.interrupt('run-1')
        host.emit('close', 143)

        // An interrupted turn still reports the work it did — the analog of the
        // partial token counts such a turn keeps, where its cost is lost.
        expect(h.messages.at(-1)).toMatchObject({
          interrupted: true,
          durationMs: 3_000,
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('reports no duration for a run that never reached a host', () => {
      const h = harness({ resolveRunPaths: () => { throw new Error('no cwd') } })
      h.manager.startRun(makeStart())

      // Nothing was spawned, so there is nothing to have timed. The ride will
      // carry no time rather than a fabricated zero-length one.
      expect(h.messages.at(-1)).not.toHaveProperty('durationMs')
    })
  })

  it('synthesizes a failed done naming a host crash when the host closes without a done', () => {
    const h = harness()
    h.manager.startRun(makeStart())

    h.hosts[0].emit('close', 1)

    expect(h.messages).toEqual([
      {
        type: 'done',
        runId: 'run-1',
        exitCode: 1,
        interrupted: false,
        stderr: '',
        cause: 'host-crash',
        // A host that never wrote a line worked no time — and reports that,
        // rather than staying silent about it.
        durationMs: 0,
      },
    ])
  })

  it('does not count the spawn and its setup as working time', () => {
    vi.useFakeTimers()
    try {
      // A real spawn takes milliseconds (and a loaded test machine can stretch the
      // fake one past a rounding boundary); the fake clock makes that deterministic.
      const hosts: FakeHost[] = []
      const h = harness({
        spawnHost: () => {
          const host = new FakeHost()
          hosts.push(host)
          vi.advanceTimersByTime(7)
          return host as unknown as ChildProcess
        },
      })
      h.manager.startRun(makeStart())

      hosts[0].emit('close', 1)

      expect(h.messages.at(-1)).toMatchObject({ cause: 'host-crash', durationMs: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a host spawn error as a failed done', () => {
    const h = harness()
    h.manager.startRun(makeStart())

    h.hosts[0].emit('error', new Error('spawn ENOENT'))

    expect(h.messages).toEqual([
      {
        type: 'done',
        runId: 'run-1',
        exitCode: 1,
        interrupted: false,
        stderr: 'error spawning flow host: spawn ENOENT',
        durationMs: 0,
      },
    ])
  })

  it('replays buffered session, turn-context, update, and done until acked', () => {
    const h = harness()
    h.manager.startRun(makeStart())
    const host = h.hosts[0]
    push(host, { kind: 'session', sessionId: 'sess-x' })
    push(host, { kind: 'turn-context', context: 'ctx' })
    push(host, {
      kind: 'update',
      steps: [{ kind: 'text', text: 'hi', createdAt: 't' }],
      finalText: 'hi',
      blockedIds: [],
      usageChanged: false,
    })
    push(host, { kind: 'done', exitCode: 0, stderr: '' })
    h.messages.length = 0

    // A server reconnect replays the minted session, the turn-context baseline,
    // buffered updates after its last seq, and the done.
    h.manager.resumeFrom('run-1', 0)
    expect(h.messages.map((m) => m.type)).toEqual([
      'session',
      'turn-context',
      'update',
      'done',
    ])

    // After ack the buffer is dropped; a later resume finds no record.
    h.messages.length = 0
    h.manager.ack('run-1')
    h.manager.resumeFrom('run-1', 1)
    expect(h.messages).toEqual([
      {
        type: 'done',
        runId: 'run-1',
        exitCode: 1,
        interrupted: false,
        stderr: 'daemon has no record of this run (restarted?); run aborted',
      },
    ])
  })

  it('re-sends only what the run recorded on resume-from', () => {
    const h = harness()
    h.manager.startRun(makeStart())
    const host = h.hosts[0]
    push(host, { kind: 'session', sessionId: 'sess-x' })
    push(host, { kind: 'turn-context', context: 'ctx' })
    h.messages.length = 0

    h.manager.resumeFrom('run-1', 0)

    expect(h.messages).toEqual([
      { type: 'session', runId: 'run-1', sessionId: 'sess-x' },
      { type: 'turn-context', runId: 'run-1', context: 'ctx' },
    ])
  })

  it('forwards a state-patch and replays it on resume-from', () => {
    // A flow's durable-state write must survive a server restart mid-turn, so the
    // supervisor buffers batches like it does mintedSession/sentContext. The
    // replay is safe to send unconditionally because the server's applyStatePatch
    // rev guard drops a batch it already folded in.
    const h = harness()
    h.manager.startRun(makeStart())
    const host = h.hosts[0]

    push(host, {
      kind: 'state-patch',
      ops: [{ op: 'set', path: ['sessionId'], value: 'sess-1' }],
      rev: 8,
    })
    push(host, {
      kind: 'state-patch',
      ops: [{ op: 'set', path: ['phase'], value: 'building' }],
      rev: 9,
    })

    expect(h.messages).toEqual([
      {
        type: 'state-patch',
        runId: 'run-1',
        ops: [{ op: 'set', path: ['sessionId'], value: 'sess-1' }],
        rev: 8,
      },
      {
        type: 'state-patch',
        runId: 'run-1',
        ops: [{ op: 'set', path: ['phase'], value: 'building' }],
        rev: 9,
      },
    ])

    h.messages.length = 0
    h.manager.resumeFrom('run-1', 0)
    // Both batches replay, in order, revs intact — the server dedupes.
    expect(h.messages).toEqual([
      {
        type: 'state-patch',
        runId: 'run-1',
        ops: [{ op: 'set', path: ['sessionId'], value: 'sess-1' }],
        rev: 8,
      },
      {
        type: 'state-patch',
        runId: 'run-1',
        ops: [{ op: 'set', path: ['phase'], value: 'building' }],
        rev: 9,
      },
    ])
  })

  it('ignores a host event kind it does not know', () => {
    // The host is spawned from source per run, so a freshly-committed host can be
    // one generation newer than its still-running supervisor. Unknown kinds must
    // be dropped silently rather than crash the run — which is also why routing
    // for a new kind has to land before its first emitter.
    const h = harness()
    h.manager.startRun(makeStart())
    push(h.hosts[0], { kind: 'from-the-future' } as unknown as HostEvent)
    push(h.hosts[0], { kind: 'done', exitCode: 0, stderr: '' })

    expect(h.messages.map((m) => m.type)).toEqual(['done'])
  })

  it('triggers a usage refresh on done for a usage-snapshot flow', () => {
    const refreshUsage = vi.fn()
    const h = harness({ refreshUsage })
    h.manager.startRun(makeStart({ agent: 'claude' }))

    push(h.hosts[0], { kind: 'done', exitCode: 0, stderr: '' })

    expect(refreshUsage).toHaveBeenCalledWith('claude')
  })

  it('stops every held host on stopAll, naming the shutdown as the cause', async () => {
    const h = harness()
    h.manager.startRun(makeStart({ runId: 'run-1' }))
    h.manager.startRun(makeStart({ runId: 'run-2' }))

    let allStopped = false
    const stopped = h.manager.stopAll().then(() => {
      allStopped = true
    })

    expect(h.hosts[0].kill).toHaveBeenCalledWith('SIGTERM')
    expect(h.hosts[1].kill).toHaveBeenCalledWith('SIGTERM')

    // The shutdown waits for every host, not just the first to close.
    h.hosts[0].emit('close', 143)
    await new Promise((r) => setImmediate(r))
    expect(allStopped).toBe(false)
    h.hosts[1].emit('close', 143)
    await stopped

    // The synthesized dones name the deliberate shutdown, not a crash.
    expect(
      h.messages.filter((m) => m.type === 'done').map((m) => m),
    ).toMatchObject([
      { runId: 'run-1', exitCode: 1, cause: 'daemon-shutdown' },
      { runId: 'run-2', exitCode: 1, cause: 'daemon-shutdown' },
    ])
  })

  it('aborts a run interrupted while its attachments were still materializing', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = harness({
      materialize: async () => {
        await gate
        return { filesDir: '/mat', manifestBlock: '' }
      },
    })

    h.manager.startRun(
      makeStart({
        agent: 'codex',
        attachments: [{ id: 'a', name: 'a', mime: 'text/plain', size: 1 }],
      }),
    )
    h.manager.interrupt('run-1')
    release()
    await vi.waitFor(() =>
      expect(h.messages).toContainEqual({
        type: 'done',
        runId: 'run-1',
        exitCode: 0,
        interrupted: true,
        stderr: '',
      }),
    )
    // The interrupt landed before any host spawned.
    expect(h.hosts).toHaveLength(0)
  })

  describe('a run launched in the task’s checkout', () => {
    const checkoutPaths = () => ({
      root: '/repo',
      cwd: '/repo/.worktrees/task-1',
      reentryArgs: [],
      checkout: '/repo/.worktrees/task-1',
    })

    const report = {
      path: '/repo/.worktrees/task-1',
      branch: 'feature',
      files: [{ path: 'a.ts', added: 2, removed: 1 }],
    }

    it('waits for prepare, then launches there and reports the checkout on done', async () => {
      let release!: () => void
      const prepare = vi.fn(() => new Promise<void>((r) => (release = r)))
      const checkoutReport = vi.fn(async () => report)
      const h = harness({
        resolveRunPaths: checkoutPaths,
        prepare,
        checkoutReport,
      })
      h.manager.startRun(makeStart())
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-1' }),
        expect.objectContaining({ checkout: '/repo/.worktrees/task-1' }),
      )
      expect(h.hosts).toHaveLength(0)
      expect(h.manager.heldRunIds()).toEqual(['run-1'])
      release()
      await vi.waitFor(() => expect(h.hosts).toHaveLength(1))
      const input = hostInputOf(h.hosts[0])
      expect(input.cwd).toBe('/repo/.worktrees/task-1')
      expect(input.checkout).toBe('/repo/.worktrees/task-1')
      push(h.hosts[0], { kind: 'done', exitCode: 0, stderr: '' })
      await vi.waitFor(() =>
        expect(h.messages.at(-1)).toMatchObject({ type: 'done', checkout: report }),
      )
      expect(checkoutReport).toHaveBeenCalledWith('/repo', '/repo/.worktrees/task-1')
    })

    it('holds the done until the report is read, and replays it with the report', async () => {
      let resolve!: (r: typeof report) => void
      const h = harness({
        resolveRunPaths: checkoutPaths,
        prepare: () => undefined,
        checkoutReport: () => new Promise((r) => (resolve = r)),
      })
      h.manager.startRun(makeStart())
      push(h.hosts[0], { kind: 'done', exitCode: 0, stderr: '' })
      h.manager.resumeFrom('run-1', 0)
      expect(h.messages.filter((m) => m.type === 'done')).toEqual([])
      resolve(report)
      await vi.waitFor(() => expect(h.messages.at(-1)).toMatchObject({ type: 'done' }))
      h.manager.resumeFrom('run-1', 0)
      expect(h.messages.filter((m) => m.type === 'done')).toEqual([
        expect.objectContaining({ checkout: report }),
        expect.objectContaining({ checkout: report }),
      ])
    })

    it('reports the checkout once the run spawns, and replays it before the done', async () => {
      const h = harness({
        resolveRunPaths: checkoutPaths,
        prepare: () => undefined,
        checkoutReport: async () => report,
      })
      h.manager.startRun(makeStart())
      const started = { type: 'checkout', runId: 'run-1', checkout: report }
      await vi.waitFor(() => expect(h.messages).toEqual([started]))
      push(h.hosts[0], { kind: 'done', exitCode: 0, stderr: '' })
      await vi.waitFor(() => expect(h.messages.at(-1)).toMatchObject({ type: 'done' }))
      h.messages.length = 0
      h.manager.resumeFrom('run-1', 0)
      expect(h.messages).toEqual([started, expect.objectContaining({ type: 'done' })])
    })

    describe('after tools run', () => {
      const toolResult: HostEvent = {
        kind: 'update',
        steps: [{ kind: 'tool_result', toolUseId: 't1', createdAt: 't' }],
        blockedIds: [],
        usageChanged: false,
      }
      const text: HostEvent = {
        kind: 'update',
        steps: [{ kind: 'text', text: 'hi', createdAt: 't' }],
        blockedIds: [],
        usageChanged: false,
      }

      function refreshing() {
        const reads: ((r: typeof report) => void)[] = []
        const h = harness({
          resolveRunPaths: checkoutPaths,
          prepare: () => undefined,
          checkoutReport: () => new Promise((r) => reads.push(r)),
          checkoutRefreshMs: 1_000,
        })
        h.manager.startRun(makeStart())
        const checkouts = () => h.messages.filter((m) => m.type === 'checkout')
        return { h, reads, checkouts }
      }

      beforeEach(() => vi.useFakeTimers())
      afterEach(() => vi.useRealTimers())

      it('reads the checkout again once the wait after the last read is over', async () => {
        const { h, reads, checkouts } = refreshing()
        reads[0](report)
        await vi.advanceTimersByTimeAsync(0)
        push(h.hosts[0], toolResult)
        push(h.hosts[0], toolResult)
        expect(reads).toHaveLength(1)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(reads).toHaveLength(2)
        const edited = { ...report, branch: 'edited' }
        reads[1](edited)
        await vi.advanceTimersByTimeAsync(0)
        expect(checkouts().at(-1)).toMatchObject({ checkout: edited })
        await vi.advanceTimersByTimeAsync(5_000)
        expect(reads).toHaveLength(2)
      })

      it('reads after a tool that finished during a read', async () => {
        const { h, reads } = refreshing()
        push(h.hosts[0], toolResult)
        reads[0](report)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(reads).toHaveLength(2)
      })

      it('does not read again for updates without a tool result', async () => {
        const { h, reads } = refreshing()
        reads[0](report)
        await vi.advanceTimersByTimeAsync(0)
        push(h.hosts[0], text)
        await vi.advanceTimersByTimeAsync(5_000)
        expect(reads).toHaveLength(1)
      })

      it('replays only the latest report', async () => {
        const { h, reads, checkouts } = refreshing()
        reads[0](report)
        await vi.advanceTimersByTimeAsync(0)
        push(h.hosts[0], toolResult)
        await vi.advanceTimersByTimeAsync(1_000)
        const edited = { ...report, branch: 'edited' }
        reads[1](edited)
        await vi.advanceTimersByTimeAsync(0)
        h.messages.length = 0
        h.manager.resumeFrom('run-1', 0)
        expect(checkouts()).toEqual([{ type: 'checkout', runId: 'run-1', checkout: edited }])
      })
    })

    it('sends the done without a checkout when the report fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const h = harness({
          resolveRunPaths: checkoutPaths,
          prepare: () => undefined,
          checkoutReport: () => Promise.reject(new Error('git timed out')),
        })
        h.manager.startRun(makeStart())
        push(h.hosts[0], { kind: 'done', exitCode: 0, stderr: '' })
        await vi.waitFor(() => expect(h.messages.at(-1)).toMatchObject({ type: 'done' }))
        expect(h.messages.at(-1)).not.toHaveProperty('checkout')
      } finally {
        error.mockRestore()
      }
    })

    it('says nothing about a checkout for a run outside one', () => {
      const h = harness()
      h.manager.startRun(makeStart())
      push(h.hosts[0], { kind: 'done', exitCode: 0, stderr: '' })
      expect(h.messages.at(-1)).not.toHaveProperty('checkout')
    })

    it('fails the run, naming the worktree, when prepare rejects', async () => {
      const onEmpty = vi.fn()
      const h = harness({
        resolveRunPaths: checkoutPaths,
        prepare: () => Promise.reject(new Error('not a git worktree')),
        onEmpty,
      })
      h.manager.startRun(makeStart())
      await vi.waitFor(() =>
        expect(h.messages).toContainEqual(
          expect.objectContaining({
            type: 'done',
            exitCode: 1,
            stderr: 'failed to prepare the task’s worktree: not a git worktree',
          }),
        ),
      )
      expect(h.hosts).toHaveLength(0)
      expect(h.manager.size()).toBe(0)
      expect(onEmpty).toHaveBeenCalledTimes(1)
    })
  })

  describe('a run still before its spawn', () => {
    function gated(fail = false) {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const onEmpty = vi.fn()
      const h = harness({
        onEmpty,
        materialize: async () => {
          await gate
          if (fail) throw new Error('fetch failed')
          return { filesDir: '/mat', manifestBlock: '' }
        },
      })
      h.manager.startRun(
        makeStart({
          agent: 'codex',
          attachments: [{ id: 'a', name: 'a', mime: 'text/plain', size: 1 }],
        }),
      )
      return { ...h, release, onEmpty }
    }

    it('counts as held, so a drain waits and a re-register names it', async () => {
      const h = gated()
      expect(h.manager.size()).toBe(1)
      expect(h.manager.heldRunIds()).toEqual(['run-1'])
      h.release()
      await vi.waitFor(() => expect(h.hosts).toHaveLength(1))
      // Spawned: the Run record holds it now, once.
      expect(h.manager.size()).toBe(1)
      expect(h.manager.heldRunIds()).toEqual(['run-1'])
      expect(h.onEmpty).not.toHaveBeenCalled()
    })

    it('ignores a resume-from rather than aborting it', async () => {
      const h = gated()
      h.manager.resumeFrom('run-1', 0)
      expect(h.messages).toEqual([])
      h.release()
      await vi.waitFor(() => expect(h.hosts).toHaveLength(1))
      push(h.hosts[0], { kind: 'done', exitCode: 0, stderr: '' })
      expect(h.messages.map((m) => m.type)).toEqual(['done'])
      expect(h.messages[0]).toMatchObject({ exitCode: 0 })
    })

    it('releases its hold when it fails before spawning', async () => {
      const h = gated(true)
      h.release()
      await vi.waitFor(() =>
        expect(h.messages).toContainEqual(
          expect.objectContaining({ type: 'done', runId: 'run-1', exitCode: 1 }),
        ),
      )
      expect(h.manager.size()).toBe(0)
      expect(h.onEmpty).toHaveBeenCalledTimes(1)
    })

    it('releases its hold when failed by the daemon before spawning', () => {
      const h = gated()
      h.manager.failRun('run-1', 'daemon error: boom')
      expect(h.manager.size()).toBe(0)
      expect(h.onEmpty).toHaveBeenCalledTimes(1)
      expect(h.messages).toContainEqual(
        expect.objectContaining({ type: 'done', exitCode: 1, stderr: 'daemon error: boom' }),
      )
    })

    it('settles, rather than crashing the daemon, when the spawn after it throws', async () => {
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const onEmpty = vi.fn()
      const h = harness({
        onEmpty,
        spawnHost: () => {
          throw new Error('no host')
        },
        materialize: async () => {
          await gate
          return { filesDir: '/mat', manifestBlock: '' }
        },
      })
      h.manager.startRun(
        makeStart({
          agent: 'codex',
          attachments: [{ id: 'a', name: 'a', mime: 'text/plain', size: 1 }],
        }),
      )
      release()
      await vi.waitFor(() =>
        expect(h.messages).toContainEqual(
          expect.objectContaining({ type: 'done', exitCode: 1, stderr: 'daemon error: no host' }),
        ),
      )
      expect(h.manager.size()).toBe(0)
      expect(onEmpty).toHaveBeenCalledTimes(1)
    })

    it('never spawns once the daemon has begun stopping its runs', async () => {
      const h = gated()
      await h.manager.stopAll()
      h.release()
      await vi.waitFor(() =>
        expect(h.messages).toContainEqual(
          expect.objectContaining({ type: 'done', runId: 'run-1', exitCode: 1 }),
        ),
      )
      h.manager.startRun(makeStart({ runId: 'run-2' }))
      expect(h.messages).toContainEqual(
        expect.objectContaining({ type: 'done', runId: 'run-2', exitCode: 1 }),
      )
      expect(h.hosts).toHaveLength(0)
      expect(h.manager.size()).toBe(0)
    })

    it('releases its hold when interrupted before spawning', async () => {
      const h = gated()
      h.manager.interrupt('run-1')
      h.release()
      await vi.waitFor(() =>
        expect(h.messages).toContainEqual(
          expect.objectContaining({ type: 'done', interrupted: true }),
        ),
      )
      expect(h.manager.size()).toBe(0)
      expect(h.onEmpty).toHaveBeenCalledTimes(1)
    })
  })
})
