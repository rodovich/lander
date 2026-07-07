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
      allowCommits: false,
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
  it('spawns the selected provider binary with provider session args', () => {
    const h = harness()

    h.manager.startRun(makeStart({ agent: 'codex', prompt: 'codex prompt' }))
    h.manager.startRun(
      makeStart({
        runId: 'run-2',
        agent: 'claude',
        prompt: 'claude prompt',
      }),
    )

    expect(h.spawns[0]).toMatchObject({
      command: 'codex',
      args: [
        'exec',
        '--json',
        '--config',
        'shell_environment_policy.set.LANDER_TASK="task-1"',
        '--cd',
        '/repo',
        '--sandbox',
        'read-only',
        'Prompt: This Codex turn runs with the read-only sandbox. Task allow rules and commit-only grants are stored by Lander but do not affect Codex runs yet.\n\ncodex prompt',
      ],
      options: { cwd: '/repo' },
    })
    expect(h.spawns[1]).toMatchObject({
      command: 'claude',
      args: [
        '--session-id',
        'minted-session',
        '--allowedTools',
        'Bash(lander:*)',
        '--settings',
        expect.any(String),
        '--append-system-prompt',
        'Prompt: You currently have no edit or commit permissions, so a spawned task cannot be granted them either.',
        '--output-format',
        'stream-json',
        '--verbose',
        '-p',
        '--',
        'claude prompt',
      ],
      options: { cwd: '/repo' },
    })
    expect(h.messages).toContainEqual({
      type: 'session',
      runId: 'run-2',
      sessionId: 'minted-session',
    })
  })

  it('reduces stdout into session, update, and done messages', () => {
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

    expect(h.messages.map((m) => m.type)).toEqual(['session', 'update', 'done'])
    expect(h.messages[0]).toMatchObject({
      type: 'session',
      runId: 'run-1',
      sessionId: 'thread-1',
    })
    expect(h.messages[1]).toMatchObject({
      type: 'update',
      runId: 'run-1',
      seq: 1,
      finalText: 'codex ok',
    })
    expect(h.messages[2]).toMatchObject({
      type: 'done',
      runId: 'run-1',
      exitCode: 0,
      interrupted: false,
      stderr: '',
    })
  })

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
})
