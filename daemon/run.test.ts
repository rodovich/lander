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
        'sandbox_workspace_write.network_access=true',
        '--config',
        'shell_environment_policy.inherit=all',
        '--config',
        'shell_environment_policy.ignore_default_excludes=true',
        '--config',
        'shell_environment_policy.include_only=["PATH","LANDER_*"]',
        '--cd',
        '/repo',
        '--sandbox',
        'read-only',
        'Prompt: This Codex turn runs with the read-only sandbox. Task allow rules are stored by Lander but do not affect Codex runs yet.\n\ncodex prompt',
      ],
      options: { cwd: '/repo' },
    })
    const claudeContext = [
      '<task-context>',
      "Task state as of this message — background context from lander, not the user's words. Re-sent only when it changes.",
      '',
      'You currently have no edit permission, so a spawned task cannot be granted it either.',
      '',
      'Git status as of this message:',
      '',
      'on branch test',
      '</task-context>',
    ].join('\n')
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
        'Prompt: Your own current grants — which cap what you can forward — are stated in the task-context block in the conversation.\n\n' +
          '# Git\n' +
          '- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.\n' +
          '- Use the `gh` CLI for GitHub operations (PRs, issues, API).\n' +
          '- Commit or push only when the user asks. If on the default branch, branch first.',
        '--output-format',
        'stream-json',
        '--verbose',
        '-p',
        '--',
        `claude prompt\n\n${claudeContext}`,
      ],
      options: { cwd: '/repo' },
    })
    expect(h.messages).toContainEqual({
      type: 'session',
      runId: 'run-2',
      sessionId: 'minted-session',
    })
    // The appended block is announced so the server records it as the baseline
    // for the next turn's changed-comparison.
    expect(h.messages).toContainEqual({
      type: 'turn-context',
      runId: 'run-2',
      context: claudeContext,
    })
    // Codex has no context builder: its prompt is untouched and nothing announced.
    expect(
      h.messages.find((m) => m.type === 'turn-context' && m.runId === 'run-1'),
    ).toBeUndefined()
  })

  it('omits an unchanged turn context and appends a changed one', () => {
    const h = harness()

    // Resume with the baseline matching what the adapter regenerates: the
    // prompt goes out bare and no turn-context is announced.
    h.manager.startRun(
      makeStart({
        agent: 'claude',
        prompt: 'follow-up',
        sessionId: 'sess-1',
      }),
    )
    const unchanged = h.spawns[0].args.at(-1)!
    expect(unchanged.startsWith('follow-up\n\n<task-context>')).toBe(true)
    const context = unchanged.slice('follow-up\n\n'.length)

    h.manager.startRun(
      makeStart({
        runId: 'run-2',
        agent: 'claude',
        prompt: 'follow-up',
        sessionId: 'sess-1',
        turnContext: context,
      }),
    )
    expect(h.spawns[1].args.at(-1)).toBe('follow-up')
    expect(
      h.messages.find((m) => m.type === 'turn-context' && m.runId === 'run-2'),
    ).toBeUndefined()

    // A stale baseline (the grants changed) re-appends and re-announces.
    h.manager.startRun(
      makeStart({
        runId: 'run-3',
        agent: 'claude',
        prompt: 'follow-up',
        sessionId: 'sess-1',
        turnContext: context,
        task: { allowEdits: true },
      }),
    )
    const changed = h.spawns[2].args.at(-1)!
    expect(changed).toContain('You currently have permission for editing files')
    expect(h.messages).toContainEqual({
      type: 'turn-context',
      runId: 'run-3',
      context: changed.slice('follow-up\n\n'.length),
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

  it('keeps the streamed cache miss on the result event usage replacement', () => {
    const h = harness()
    h.manager.startRun(makeStart({ agent: 'claude' }))
    const child = h.spawns[0].child

    child.stdout.emit(
      'data',
      Buffer.concat([
        line({
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 2, output_tokens: 3 },
            diagnostics: {
              cache_miss_reason: {
                type: 'system_changed',
                cache_missed_input_tokens: 48815,
              },
            },
          },
        }),
        line({
          type: 'result',
          result: 'hi',
          usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 10 },
        }),
      ]),
    )
    child.emit('close', 0)

    const updates = h.messages.filter((m) => m.type === 'update')
    const final = updates.at(-1)!
    expect(final.usage).toMatchObject({
      cacheRead: 10,
      cacheMiss: { reason: 'system_changed', missedTokens: 48815 },
    })
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
