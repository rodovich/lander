import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeAdapter } from './claude'
import { createCodexAdapter } from './codex'
import type { StartRunMessage } from '../server/protocol'
import type { HostEvent, HostInput } from './run-agent'
import {
  createRunManager,
  DEFAULT_IDLE_MS,
  idleFallbackMs,
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
    end() {},
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
    task: {
      allowEdits: false,
    },
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
    // The supervisor sees only a provider's capability view — never a flow or an
    // adapter — so these are the real ones the daemon builds, whichever side is
    // currently answering them.
    caps: providerCaps({
      claude: createClaudeAdapter({
        landerBin: '/repo/bin/lander',
        taskPromptTemplate: 'Prompt: {{forwardable}}.',
      }),
      codex: createCodexAdapter({
        taskPromptTemplate: 'Prompt: {{forwardable}}.',
      }),
    }),
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

describe('idle fallback', () => {
  it('takes the daemon default when nothing overrides it', () => {
    expect(idleFallbackMs({})).toBe(DEFAULT_IDLE_MS)
  })

  it('honors a positive override', () => {
    expect(idleFallbackMs({ LANDER_IDLE_TIMEOUT_MS: '90000' })).toBe(90_000)
  })

  it('ignores a value that is not a positive number', () => {
    // Each of these reaches setTimeout as an immediate fire through
    // `msg.idleTimeoutMs || defaultIdleMs`, so a typo would kill every run the
    // moment it started rather than being ignored.
    for (const raw of ['', '   ', 'abc', '0', '-1', 'Infinity'])
      expect(idleFallbackMs({ LANDER_IDLE_TIMEOUT_MS: raw })).toBe(DEFAULT_IDLE_MS)
  })
})

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
        images: ['/mat/img1'],
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
    expect(input.materialized).toMatchObject({ images: ['/mat/img1'] })
  })

  it('sets the files dir in the HostInput on a turn carrying no attachments', () => {
    const h = harness()
    h.manager.startRun(makeStart({ agent: 'codex' }))
    expect(h.hosts).toHaveLength(1)
    expect(hostInputOf(h.hosts[0]).filesDir).toBe('/files/proj/task-1')
  })

  it('interrupts by killing the host group and emitting an interrupted done', () => {
    const h = harness()
    h.manager.startRun(makeStart())
    const host = h.hosts[0]

    h.manager.interrupt('run-1')

    expect(host.kill).toHaveBeenCalledWith('SIGKILL')
    expect(h.messages.at(-1)).toMatchObject({
      type: 'done',
      runId: 'run-1',
      exitCode: 0,
      interrupted: true,
    })
  })

  it('idle-kills the host and synthesizes a non-interrupted failed done', () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      h.manager.startRun(makeStart({ idleTimeoutMs: 50 }))
      const host = h.hosts[0]

      vi.advanceTimersByTime(50)
      expect(host.kill).toHaveBeenCalledWith('SIGKILL')

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
      },
    ])
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

    expect(refreshUsage).toHaveBeenCalled()
  })

  it('kills every held host group on killChildren, naming the shutdown as the cause', () => {
    const h = harness()
    h.manager.startRun(makeStart({ runId: 'run-1' }))
    h.manager.startRun(makeStart({ runId: 'run-2' }))

    h.manager.killChildren()

    expect(h.hosts[0].kill).toHaveBeenCalledWith('SIGKILL')
    expect(h.hosts[1].kill).toHaveBeenCalledWith('SIGKILL')

    // The killed hosts close without a natural done; the synthesized dones name
    // the deliberate shutdown, not a crash.
    h.hosts[0].emit('close', 137)
    h.hosts[1].emit('close', 137)
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
        return { filesDir: '/mat', images: [], manifestBlock: '' }
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
})
