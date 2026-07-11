import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeAdapter } from './claude'
import { createCodexAdapter } from './codex'
import type { StartRunMessage } from '../server/protocol'
import type { HostEvent, HostInput } from './run-agent'
import { runHost } from './flow-host'

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

function makeInput(
  over: Partial<StartRunMessage> = {},
  input: Partial<HostInput> = {},
): HostInput {
  return { start: makeStart(over), root: '/repo', cwd: '/repo', ...input }
}

// Test-configured adapters (a fixed prompt template + a stub git snapshot), so the
// arg assertions don't depend on the real task-prompt.md or the host's git tree.
function testAdapters() {
  return {
    claude: createClaudeAdapter({
      landerBin: '/repo/bin/lander',
      taskPromptTemplate: 'Prompt: {{forwardable}}.',
      readGitContext: () => 'Git status as of this message:\n\non branch test',
    }),
    codex: createCodexAdapter({
      taskPromptTemplate: 'Prompt: {{forwardable}}.',
    }),
  }
}

function harness() {
  const events: HostEvent[] = []
  const spawns: SpawnCall[] = []
  const stderr: string[] = []
  const spawn = (command: string, args: string[], options: SpawnOptions) => {
    const child = new FakeChild()
    spawns.push({ command, args, options, child })
    return child as unknown as ChildProcess
  }
  const run = (input: HostInput) =>
    runHost(input, {
      emit: (e) => events.push(e),
      spawn,
      mintSessionId: () => 'minted-session',
      now: () => '2026-01-01T00:00:00.000Z',
      onStderr: (c) => stderr.push(c),
      adapters: testAdapters(),
    })
  return { events, spawns, stderr, run }
}

describe('flow host', () => {
  it('spawns the selected provider binary with provider session args', () => {
    const h = harness()

    h.run(makeInput({ agent: 'codex', prompt: 'codex prompt' }))
    h.run(
      makeInput({ runId: 'run-2', agent: 'claude', prompt: 'claude prompt' }),
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
    // The host emits neutral (seq-less) session/turn-context events; the daemon
    // adds runId/seq. Claude minted + announced its session and its context block.
    expect(h.events).toContainEqual({
      kind: 'session',
      sessionId: 'minted-session',
    })
    expect(h.events).toContainEqual({
      kind: 'turn-context',
      context: claudeContext,
    })
    // Codex has no context builder: its prompt is untouched and nothing announced.
    expect(h.events.filter((e) => e.kind === 'turn-context')).toHaveLength(1)
  })

  it('omits an unchanged turn context and appends a changed one', () => {
    const h = harness()

    // Resume with the baseline matching what the adapter regenerates: the prompt
    // goes out bare and no turn-context is emitted.
    h.run(makeInput({ agent: 'claude', prompt: 'follow-up', sessionId: 'sess-1' }))
    const unchanged = h.spawns[0].args.at(-1)!
    expect(unchanged.startsWith('follow-up\n\n<task-context>')).toBe(true)
    const context = unchanged.slice('follow-up\n\n'.length)

    h.run(
      makeInput({
        runId: 'run-2',
        agent: 'claude',
        prompt: 'follow-up',
        sessionId: 'sess-1',
        turnContext: context,
      }),
    )
    expect(h.spawns[1].args.at(-1)).toBe('follow-up')
    expect(h.events.filter((e) => e.kind === 'turn-context')).toHaveLength(1)

    // A stale baseline (the grants changed) re-appends and re-emits.
    h.run(
      makeInput({
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
    expect(h.events).toContainEqual({
      kind: 'turn-context',
      context: changed.slice('follow-up\n\n'.length),
    })
  })

  it('reduces stdout into session, update, and done events', () => {
    const h = harness()
    h.run(makeInput())
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

    expect(h.events.map((e) => e.kind)).toEqual(['session', 'update', 'done'])
    expect(h.events[0]).toMatchObject({ kind: 'session', sessionId: 'thread-1' })
    expect(h.events[1]).toMatchObject({ kind: 'update', finalText: 'codex ok' })
    expect(h.events[2]).toMatchObject({ kind: 'done', exitCode: 0, stderr: '' })
  })

  it('extracts the codex session id mid-stream and emits it once', () => {
    const h = harness()
    h.run(makeInput())
    const child = h.spawns[0].child

    // The thread id arrives in its own chunk, after the run began.
    child.stdout.emit('data', line({ type: 'thread.started', thread_id: 'thread-9' }))
    child.stdout.emit(
      'data',
      line({
        type: 'item.completed',
        item: { id: 'item-1', type: 'agent_message', text: 'ok' },
      }),
    )
    child.emit('close', 0)

    expect(h.events.filter((e) => e.kind === 'session')).toEqual([
      { kind: 'session', sessionId: 'thread-9' },
    ])
  })

  it('keeps the streamed cache miss on the result event usage replacement', () => {
    const h = harness()
    h.run(makeInput({ agent: 'claude' }))
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

    const updates = h.events.filter((e) => e.kind === 'update')
    const final = updates.at(-1)!
    expect(final.kind === 'update' && final.usage).toMatchObject({
      cacheRead: 10,
      cacheMiss: { reason: 'system_changed', missedTokens: 48815 },
    })
  })

  it('folds a terminalError into a non-zero done even on a clean exit', () => {
    const h = harness()
    h.run(makeInput())
    const child = h.spawns[0].child

    child.stdout.emit('data', line({ type: 'error', message: 'boom' }))
    child.emit('close', 0)

    const done = h.events.at(-1)!
    expect(done).toMatchObject({ kind: 'done', exitCode: 1 })
    expect(done.kind === 'done' && done.stderr).toContain('boom')
  })

  it('relays agent stderr to the host stderr for the idle watchdog', () => {
    const h = harness()
    h.run(makeInput())
    const child = h.spawns[0].child

    child.stderr.emit('data', Buffer.from('agent noise'))

    expect(h.stderr).toContain('agent noise')
  })

  it('passes materialized image paths and LANDER_FILES_DIR to Codex', () => {
    const h = harness()
    h.run(
      makeInput(
        { agent: 'codex', prompt: 'look' },
        {
          filesDir: '/files/proj/task-1',
          materialized: {
            filesDir: '/files/proj/task-1',
            images: ['/files/proj/task-1/img1'],
            manifestBlock: '<task-attachments>\n…\n</task-attachments>',
          },
        },
      ),
    )

    const [call] = h.spawns
    // Fresh exec places `-i <path>` after the positional prompt.
    const prompt = call.args[call.args.indexOf('-i') - 1]
    expect(prompt).toContain('look')
    expect(prompt).toContain('<task-attachments>')
    expect(call.args.slice(-2)).toEqual(['-i', '/files/proj/task-1/img1'])
    expect((call.options.env as Record<string, string>).LANDER_FILES_DIR).toBe(
      '/files/proj/task-1',
    )
  })

  it('builds the real compiled-in adapters when none are injected', () => {
    const events: HostEvent[] = []
    const spawns: SpawnCall[] = []
    runHost(makeInput({ agent: 'codex', prompt: 'x' }), {
      emit: (e) => events.push(e),
      spawn: (command, args, options) => {
        const child = new FakeChild()
        spawns.push({ command, args, options, child })
        return child as unknown as ChildProcess
      },
      mintSessionId: () => 'm',
      now: () => '2026-01-01T00:00:00.000Z',
    })

    expect(spawns[0].command).toBe('codex')
    expect(spawns[0].args.slice(0, 2)).toEqual(['exec', '--json'])
  })
})
