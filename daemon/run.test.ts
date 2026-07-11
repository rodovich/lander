import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeAdapter } from './claude'
import { createCodexAdapter } from './codex'
import type { StartRunMessage } from '../server/protocol'
import type { RunManagerMessage } from './run'
import { createRunManager } from './run'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn(() => true)
}

type SpawnCall = {
  command: string
  args: string[]
  options: SpawnOptions
  child: FakeChild
}

function line(event: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(event)}\n`)
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

function harness() {
  const messages: RunManagerMessage[] = []
  const spawns: SpawnCall[] = []
  const spawn = (command: string, args: string[], options: SpawnOptions) => {
    const child = new FakeChild()
    spawns.push({ command, args, options, child })
    return child as unknown as ChildProcess
  }
  const manager = createRunManager({
    adapters: {
      claude: createClaudeAdapter({
        landerBin: '/repo/bin/lander',
        taskPromptTemplate: 'Prompt: {{forwardable}}.',
        readGitContext: () => 'Git status as of this message:\n\non branch test',
      }),
      codex: createCodexAdapter({
        taskPromptTemplate: 'Prompt: {{forwardable}}.',
      }),
    },
    resolveRunPaths: () => ({ root: '/repo', cwd: '/repo' }),
    send: (msg) => messages.push(msg),
    refreshUsage: () => {},
    spawn,
    mintSessionId: () => 'minted-session',
    now: () => '2026-01-01T00:00:00.000Z',
  })
  return { manager, messages, spawns }
}

describe('daemon run manager', () => {
  it('interrupts the child and emits an interrupted done', () => {
    const h = harness()
    h.manager.startRun(makeStart())

    h.manager.interrupt('run-1')

    expect(h.spawns[0].child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(h.messages.at(-1)).toMatchObject({
      type: 'done',
      runId: 'run-1',
      exitCode: 0,
      interrupted: true,
    })
  })

  it('replays buffered session, update, and done messages until acked', () => {
    const h = harness()
    h.manager.startRun(makeStart())
    const child = h.spawns[0].child
    child.stdout.emit(
      'data',
      Buffer.concat([
        line({ type: 'thread.started', thread_id: 'thread-1' }),
        line({
          type: 'item.completed',
          item: { id: 'item-1', type: 'agent_message', text: 'codex ok' },
        }),
      ]),
    )
    child.emit('close', 0)
    h.messages.length = 0

    h.manager.resumeFrom('run-1', 0)
    expect(h.messages.map((m) => m.type)).toEqual(['session', 'update', 'done'])

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

  it('re-sends the turn context on resume-from, like the minted session', () => {
    const h = harness()
    h.manager.startRun(makeStart({ agent: 'claude' }))
    h.messages.length = 0

    h.manager.resumeFrom('run-1', 0)

    expect(h.messages.map((m) => m.type)).toEqual(['session', 'turn-context'])
  })

  it('reports child spawn errors as failed done messages', () => {
    const h = harness()
    h.manager.startRun(makeStart())

    h.spawns[0].child.emit('error', new Error('spawn ENOENT'))

    expect(h.messages).toEqual([
      {
        type: 'done',
        runId: 'run-1',
        exitCode: 1,
        interrupted: false,
        stderr: 'error running assistant: spawn ENOENT',
      },
    ])
  })

  it('materializes attachments, injects LANDER_FILES_DIR, and passes image paths to Codex', async () => {
    const messages: RunManagerMessage[] = []
    const spawns: SpawnCall[] = []
    const spawn = (command: string, args: string[], options: SpawnOptions) => {
      const child = new FakeChild()
      spawns.push({ command, args, options, child })
      return child as unknown as ChildProcess
    }
    const manager = createRunManager({
      adapters: {
        codex: createCodexAdapter({ taskPromptTemplate: 'Prompt: {{forwardable}}.' }),
      },
      resolveRunPaths: () => ({ root: '/repo', cwd: '/repo' }),
      send: (msg) => messages.push(msg),
      materialize: async () => ({
        filesDir: '/files/proj/task-1',
        images: ['/files/proj/task-1/img1'],
        manifestBlock: '<task-attachments>\n…\n</task-attachments>',
      }),
      spawn,
      now: () => '2026-01-01T00:00:00.000Z',
    })

    manager.startRun(
      makeStart({
        agent: 'codex',
        prompt: 'look',
        attachments: [{ id: 'img1', name: 'p.png', mime: 'image/png', size: 2 }],
      }),
    )
    // Materialization is async: nothing spawns on the same tick.
    expect(spawns).toHaveLength(0)
    await vi.waitFor(() => expect(spawns).toHaveLength(1))

    const [call] = spawns
    // Fresh exec places `-i <path>` after the positional prompt.
    const prompt = call.args[call.args.indexOf('-i') - 1]
    expect(prompt).toContain('look')
    expect(prompt).toContain('<task-attachments>')
    expect(call.args.slice(-2)).toEqual(['-i', '/files/proj/task-1/img1'])
    // The child env exposes the materialized files dir for `lander file cat/ls`.
    expect((call.options.env as Record<string, string>).LANDER_FILES_DIR).toBe(
      '/files/proj/task-1',
    )
  })

  it('sets LANDER_FILES_DIR every turn, even one carrying no new attachments', () => {
    const spawns: SpawnCall[] = []
    const manager = createRunManager({
      adapters: {
        codex: createCodexAdapter({ taskPromptTemplate: 'Prompt: {{forwardable}}.' }),
      },
      resolveRunPaths: () => ({ root: '/repo', cwd: '/repo' }),
      send: () => {},
      resolveFilesDir: (msg) => `/files/${msg.project}/${msg.taskId}`,
      spawn: (command, args, options) => {
        const child = new FakeChild()
        spawns.push({ command, args, options, child })
        return child as unknown as ChildProcess
      },
      now: () => '2026-01-01T00:00:00.000Z',
    })

    // No attachments: spawns synchronously, but LANDER_FILES_DIR is still injected
    // so `lander file cat/ls` can reach files from an earlier turn.
    manager.startRun(makeStart({ agent: 'codex' }))
    expect(spawns).toHaveLength(1)
    expect(
      (spawns[0].options.env as Record<string, string>).LANDER_FILES_DIR,
    ).toBe('/files/proj/task-1')
  })

  it('aborts a run interrupted while its attachments were still materializing', async () => {
    const messages: RunManagerMessage[] = []
    const spawns: SpawnCall[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const manager = createRunManager({
      adapters: {
        codex: createCodexAdapter({ taskPromptTemplate: 'Prompt: {{forwardable}}.' }),
      },
      resolveRunPaths: () => ({ root: '/repo', cwd: '/repo' }),
      send: (msg) => messages.push(msg),
      materialize: async () => {
        await gate
        return { filesDir: '/files', images: [], manifestBlock: '' }
      },
      spawn: (command, args, options) => {
        spawns.push({ command, args, options, child: new FakeChild() })
        return new FakeChild() as unknown as ChildProcess
      },
      now: () => '2026-01-01T00:00:00.000Z',
    })

    manager.startRun(
      makeStart({
        agent: 'codex',
        attachments: [{ id: 'a', name: 'a', mime: 'text/plain', size: 1 }],
      }),
    )
    manager.interrupt('run-1')
    release()
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        type: 'done',
        runId: 'run-1',
        exitCode: 0,
        interrupted: true,
        stderr: '',
      }),
    )
    expect(spawns).toHaveLength(0)
  })
})
