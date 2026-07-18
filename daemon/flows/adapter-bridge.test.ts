// The bridge runs the live compiled-adapter path's steps back through the ctx
// runtime's minter. These drive the REAL host wiring (runHost → runAgent →
// bridge) rather than the bridge in isolation, because the thing worth proving is
// that the shipped path re-mints — a bridge that worked but wasn't wired in would
// pass a unit test and change nothing on the wire.

import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { createClaudeAdapter } from '../claude'
import { createCodexAdapter } from '../codex'
import type { StartRunMessage } from '../../server/protocol'
import type { HostEvent, HostInput } from '../run-agent'
import { runHost } from '../flow-host'

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill = vi.fn(() => true)
}

type SpawnCall = { command: string; args: string[]; child: FakeChild }

function line(event: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(event)}\n`)
}

function makeInput(over: Partial<StartRunMessage> = {}): HostInput {
  return {
    start: {
      type: 'start-run',
      runId: 'run-1',
      taskId: 'task-1',
      agent: 'claude',
      project: 'proj',
      prompt: 'hello',
      task: { allowEdits: false },
      env: {},
      idleTimeoutMs: 60_000,
      ...over,
    },
    root: '/repo',
    cwd: '/repo',
  }
}

function harness() {
  const events: HostEvent[] = []
  const spawns: SpawnCall[] = []
  const run = (input: HostInput) =>
    runHost(input, {
      // Pin the compiled-adapter path: this suite is about the bridge, which is
      // what a provider that has NOT cut over still goes through. Once every
      // provider has flipped, the bridge and this suite retire together.
      liveFlows: new Set(),
      emit: (e) => events.push(e),
      spawn: (command, args, _options: SpawnOptions) => {
        const child = new FakeChild()
        spawns.push({ command, args, child })
        return child as unknown as ChildProcess
      },
      mintSessionId: () => 'minted',
      now: () => '2026-01-01T00:00:00.000Z',
      adapters: {
        claude: createClaudeAdapter({
          landerBin: '/repo/bin/lander',
          taskPromptTemplate: 'Prompt: {{forwardable}}.',
          readGitContext: () => undefined,
        }),
        codex: createCodexAdapter({ taskPromptTemplate: 'Prompt: {{forwardable}}.' }),
      },
    })
  return { events, spawns, run }
}

const updates = (events: HostEvent[]) =>
  events.filter((e): e is Extract<HostEvent, { kind: 'update' }> =>
    e.kind === 'update',
  )

describe('compiled-adapter bridge', () => {
  it('replaces provider-local tool ids with runtime-minted ones', () => {
    const h = harness()
    h.run(makeInput())
    h.spawns[0].child.stdout.emit(
      'data',
      Buffer.concat([
        line({
          type: 'assistant',
          message: {
            id: 'msg_abc',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_provider_1',
                name: 'Bash',
                input: { command: 'ls' },
              },
            ],
          },
        }),
        line({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_provider_1',
                content: 'a.ts',
              },
            ],
          },
        }),
      ]),
    )

    const [u] = updates(h.events)
    const [call, result] = u.steps
    expect(call.toolUseId).toBe('tool:run-1:0')
    expect(result.toolUseId).toBe('tool:run-1:0')
    // The inference id becomes a runtime group id too.
    expect(call.inferenceId).toBe('group:run-1:0')
    // Nothing provider-local survives onto the wire.
    expect(JSON.stringify(u)).not.toContain('toolu_provider_1')
    expect(JSON.stringify(u)).not.toContain('msg_abc')
  })

  it('changes ids and nothing else about a step', () => {
    const h = harness()
    h.run(makeInput())
    h.spawns[0].child.stdout.emit(
      'data',
      line({
        type: 'assistant',
        message: {
          id: 'msg_1',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Edit',
              input: {
                file_path: '/repo/a.ts',
                old_string: 'before',
                new_string: 'after',
              },
            },
          ],
        },
      }),
    )

    const [call] = updates(h.events)[0].steps
    expect(call).toEqual({
      kind: 'tool_use',
      tool: 'Edit',
      input: '/repo/a.ts',
      toolUseId: 'tool:run-1:0',
      inferenceId: 'group:run-1:0',
      rule: 'Edit(/repo/a.ts)',
      edits: [{ old: 'before', new: 'after' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    })
  })

  it('keeps two rides that reuse the same local ids on distinct items', () => {
    // Codex item ids restart per thread, which is exactly the collision that
    // forced ride-scoped result matching server-side. Minting per run makes it
    // inexpressible.
    const h = harness()
    for (const runId of ['ride-a', 'ride-b']) {
      h.run(makeInput({ runId, agent: 'codex' }))
      const child = h.spawns.at(-1)!.child
      child.stdout.emit(
        'data',
        Buffer.concat([
          line({
            type: 'item.started',
            item: { id: 'item_1', type: 'command_execution', command: 'ls' },
          }),
          line({
            type: 'item.completed',
            item: {
              id: 'item_1',
              type: 'command_execution',
              command: 'ls',
              exit_code: 0,
              output: 'ok',
            },
          }),
        ]),
      )
    }

    const [a, b] = updates(h.events)
    expect(a.steps.map((s) => s.toolUseId)).toEqual([
      'tool:ride-a:0',
      'tool:ride-a:0',
    ])
    expect(b.steps.map((s) => s.toolUseId)).toEqual([
      'tool:ride-b:0',
      'tool:ride-b:0',
    ])
  })

  it('normalizes a result with no observed start into an open→result pair', () => {
    // Codex reports item.failed for a command it never announced starting. That
    // used to cross as an orphan tool_result for apply.ts's fallback to adopt;
    // now the bridge synthesizes the open. This IS a shape change, not purely an
    // id change — hence a test that names it.
    const h = harness()
    h.run(makeInput({ agent: 'codex' }))
    h.spawns[0].child.stdout.emit(
      'data',
      line({
        type: 'item.failed',
        item: {
          id: 'item_9',
          type: 'command_execution',
          command: 'boom',
          exit_code: 1,
          output: 'nope',
        },
      }),
    )

    const [u] = updates(h.events)
    expect(u.steps.map((s) => s.kind)).toEqual(['tool_use', 'tool_result'])
    expect(u.steps[0].toolUseId).toBe('tool:run-1:0')
    expect(u.steps[1]).toMatchObject({
      toolUseId: 'tool:run-1:0',
      isError: true,
    })
  })

  it('resolves blocked ids through the handle map onto the wire', () => {
    const h = harness()
    h.run(makeInput())
    h.spawns[0].child.stdout.emit(
      'data',
      Buffer.concat([
        line({
          type: 'assistant',
          message: {
            id: 'msg_1',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_denied',
                name: 'Bash',
                input: { command: 'rm -rf /' },
              },
            ],
          },
        }),
        line({
          type: 'result',
          result: 'refused',
          permission_denials: [{ tool_use_id: 'toolu_denied' }],
        }),
      ]),
    )

    const u = updates(h.events).at(-1)!
    expect(u.blockedIds).toEqual(['tool:run-1:0'])
    expect(u.finalText).toBe('refused')
  })

  it('drops a denied id it never saw opened', () => {
    // It could not have folded onto any item server-side either, so dropping it
    // preserves behavior.
    const h = harness()
    h.run(makeInput())
    h.spawns[0].child.stdout.emit(
      'data',
      line({
        type: 'result',
        result: 'done',
        permission_denials: [{ tool_use_id: 'toolu_never_seen' }],
      }),
    )

    const u = updates(h.events).at(-1)!
    expect(u.blockedIds).toEqual([])
  })

  it('leaves session, turn-context and done events untouched', () => {
    const h = harness()
    h.run(makeInput({ agent: 'claude' }))
    h.spawns[0].child.emit('close', 0)

    // Only `update` passes through the bridge; the rest are relayed verbatim.
    expect(h.events.map((e) => e.kind)).toEqual([
      'session',
      'turn-context',
      'done',
    ])
    expect(h.events[0]).toEqual({ kind: 'session', sessionId: 'minted' })
    expect(h.events[1]).toMatchObject({ kind: 'turn-context' })
    expect(h.events.at(-1)).toEqual({ kind: 'done', exitCode: 0, stderr: '' })
  })

  it('preserves per-chunk update granularity', () => {
    const h = harness()
    h.run(makeInput())
    const child = h.spawns[0].child
    const assistant = (text: string) =>
      line({
        type: 'assistant',
        message: { id: 'msg_1', content: [{ type: 'text', text }] },
      })
    child.stdout.emit('data', Buffer.concat([assistant('one'), assistant('two')]))
    child.stdout.emit('data', assistant('three'))

    const us = updates(h.events)
    expect(us).toHaveLength(2)
    expect(us[0].steps).toHaveLength(2)
    expect(us[1].steps).toHaveLength(1)
  })
})
