import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assistArgv } from '../assist'
import type { StartRunMessage } from '../../server/protocol'
import type { HostEvent, HostInput } from '../run-agent'
import {
  createCtxRuntime,
  STATE_MAX_BYTES,
  type Ctx,
  type TurnResult,
} from './ctx'

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

function makeStart(over: Partial<StartRunMessage> = {}): StartRunMessage {
  return {
    type: 'start-run',
    runId: 'run-1',
    taskId: 'task-1',
    agent: 'claude',
    project: 'proj',
    prompt: 'hello',
    task: { allowEdits: false },
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

function harness(input: HostInput = makeInput()) {
  const events: HostEvent[] = []
  const spawns: SpawnCall[] = []
  const stderr: string[] = []
  const runtime = createCtxRuntime(input, {
    emit: (e) => events.push(e),
    now: () => '2026-01-01T00:00:00.000Z',
    onStderr: (c) => stderr.push(c),
    spawn: (command, args, options) => {
      const child = new FakeChild()
      spawns.push({ command, args, options, child })
      return child as unknown as ChildProcess
    },
  })
  return { events, spawns, stderr, runtime }
}

const updates = (events: HostEvent[]) =>
  events.filter((e): e is Extract<HostEvent, { kind: 'update' }> =>
    e.kind === 'update',
  )
const patches = (events: HostEvent[]) =>
  events.filter((e): e is Extract<HostEvent, { kind: 'state-patch' }> =>
    e.kind === 'state-patch',
  )

// Drive a fixture flow whose whole body runs against the real runtime.
// `runTurn` turns a throw from the flow into a `done` event with exitCode 1 —
// which is right in production (a driver that throws must not take the host with
// it) and silently fatal in a test: every `expect` in these callbacks would be
// swallowed, so an assertion could not fail. Catch what the body threw and
// re-raise it here, leaving the runtime's own behavior untouched.
// `tolerateThrow` is for the handful of tests whose subject IS a flow throwing;
// everywhere else a throw is an assertion that wanted to fail.
async function runFlow(
  h: ReturnType<typeof harness>,
  body: (ctx: Ctx) => Promise<TurnResult>,
  opts: { tolerateThrow?: boolean } = {},
): Promise<void> {
  let thrown: unknown
  await h.runtime.runTurn({
    onTurn: async (ctx) => {
      try {
        return await body(ctx)
      } catch (e) {
        thrown = e
        throw e
      }
    },
  })
  if (thrown !== undefined && !opts.tolerateThrow) throw thrown
}

describe('ctx runtime — identity', () => {
  it('mints runtime-owned ids in encounter order and nests by handle', async () => {
    const h = harness()
    await runFlow(h, async (ctx) => {
      const g = ctx.emit.group()
      const parent = ctx.emit.tool({ name: 'Agent', input: 'Explore', group: g })
      ctx.emit.message('sub prose', { group: g, parent })
      const inner = ctx.emit.tool({ name: 'Read', input: 'a.ts', parent })
      inner.result({ output: 'contents' })
      parent.result({ output: 'done' })
      return { exitCode: 0 }
    })

    const [u] = updates(h.events)
    expect(u.steps).toEqual([
      {
        kind: 'tool_use',
        tool: 'Agent',
        input: 'Explore',
        toolUseId: 'tool:run-1:0',
        inferenceId: 'group:run-1:0',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        kind: 'text',
        text: 'sub prose',
        inferenceId: 'group:run-1:0',
        parentToolUseId: 'tool:run-1:0',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        kind: 'tool_use',
        tool: 'Read',
        input: 'a.ts',
        toolUseId: 'tool:run-1:1',
        parentToolUseId: 'tool:run-1:0',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        kind: 'tool_result',
        text: 'contents',
        toolUseId: 'tool:run-1:1',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        kind: 'tool_result',
        text: 'done',
        toolUseId: 'tool:run-1:0',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ])
  })

  it('keeps ids distinct across rides of the same task', async () => {
    const first = harness(makeInput({ runId: 'ride-a' }))
    const second = harness(makeInput({ runId: 'ride-b' }))
    for (const h of [first, second])
      await runFlow(h, async (ctx) => {
        ctx.emit.tool({ name: 'Bash', input: 'ls' })
        return { exitCode: 0 }
      })

    expect(updates(first.events)[0].steps[0].toolUseId).toBe('tool:ride-a:0')
    expect(updates(second.events)[0].steps[0].toolUseId).toBe('tool:ride-b:0')
  })

  it('folds a late blocked marking onto blockedIds, not a second result', async () => {
    const h = harness()
    await runFlow(h, async (ctx) => {
      const t = ctx.emit.tool({ name: 'Bash', input: 'rm -rf /' })
      t.result({ output: 'refused', isError: true })
      // The terminal result event names the denial after the fact.
      t.result({ blocked: true })
      return { exitCode: 0 }
    })

    const [u] = updates(h.events)
    expect(u.steps.filter((s) => s.kind === 'tool_result')).toHaveLength(1)
    expect(u.blockedIds).toEqual(['tool:run-1:0'])
  })

  it('does not expose or accept raw ids on handles', async () => {
    const h = harness()
    await runFlow(h, async (ctx) => {
      const t = ctx.emit.tool({ name: 'Bash', input: 'ls' })
      // The handle carries no readable id — only the runtime's WeakMap knows it.
      expect(Object.values(t as unknown as Record<string, unknown>)).not.toContain(
        'tool:run-1:0',
      )
      expect(JSON.stringify(t)).not.toContain('run-1')
      return { exitCode: 0 }
    })
  })
})

describe('ctx runtime — durable state', () => {
  it('seeds thread identity from the legacy wire fields when flowState lacks it', async () => {
    // The silent-thread-reset guard: a task whose session predates the storage
    // flip keeps sessionId at the legacy top level forever, so a flow reading
    // only flowState would mint fresh and abandon the conversation.
    const h = harness(
      makeInput({ sessionId: 'legacy-sess', turnContext: 'legacy-ctx' }),
    )
    await runFlow(h, async (ctx) => {
      expect(ctx.state.get(['sessionId'])).toBe('legacy-sess')
      expect(ctx.state.get(['turnContext'])).toBe('legacy-ctx')
      return { exitCode: 0 }
    })
  })

  it('prefers flowState over the legacy fields', async () => {
    const h = harness(
      makeInput({
        sessionId: 'legacy-sess',
        flowState: { sessionId: 'flow-sess' },
      }),
    )
    await runFlow(h, async (ctx) => {
      expect(ctx.state.get(['sessionId'])).toBe('flow-sess')
      return { exitCode: 0 }
    })
  })

  it('seeds rev from flowStateRev so a later ride clears the server guard', async () => {
    // A counter restarting at 1 per run would have every ride after the first
    // silently dropped by applyStatePatch's `rev <= flowStateRev` guard.
    const h = harness(makeInput({ flowStateRev: 7 }))
    await runFlow(h, async (ctx) => {
      ctx.state.set(['sessionId'], 's')
      ctx.state.set(['phase'], 'building')
      return { exitCode: 0 }
    })

    const revs = patches(h.events).map((p) => p.rev)
    expect(revs[0]).toBe(8)
    expect(Math.min(...revs)).toBeGreaterThan(7)
  })

  it('starts the first batch at seed + 1 on a fresh task', async () => {
    const h = harness()
    await runFlow(h, async (ctx) => {
      ctx.state.set(['phase'], 'x')
      return { exitCode: 0 }
    })
    expect(patches(h.events)[0].rev).toBe(1)
  })

  it('reads its own writes back within the turn', async () => {
    const h = harness()
    await runFlow(h, async (ctx) => {
      ctx.state.set(['run', 'id'], 4512)
      expect(ctx.state.get(['run', 'id'])).toBe(4512)
      ctx.state.push(['log'], 'a')
      ctx.state.push(['log'], 'b')
      expect(ctx.state.get(['log'])).toEqual(['a', 'b'])
      ctx.state.delete(['run', 'id'])
      expect(ctx.state.get(['run', 'id'])).toBeUndefined()
      return { exitCode: 0 }
    })
  })

  it('flushes thread-identity writes immediately, batching the rest', async () => {
    // sessionId/turnContext exist precisely so a crash can't lose them, so they
    // must not wait for the chunk cadence.
    const h = harness()
    await runFlow(h, async (ctx) => {
      ctx.state.set(['sessionId'], 'minted')
      expect(patches(h.events)).toHaveLength(1)
      ctx.state.set(['phase'], 'later')
      expect(patches(h.events)).toHaveLength(1)
      return { exitCode: 0 }
    })
    expect(patches(h.events)).toHaveLength(2)
  })
})

describe('ctx runtime — emission cadence and metering', () => {
  it('flushes once per stdout chunk, not per line', async () => {
    const h = harness()
    const done = runFlow(h, async (ctx) => {
      const child = ctx.spawn('agent', [])
      for await (const line of child.lines())
        ctx.emit.message(`saw ${line}`)
      return { exitCode: await child.exit }
    })
    await Promise.resolve()
    const child = h.spawns[0].child
    // One chunk carrying three lines must produce ONE update, not three: a
    // per-line flush would multiply UpdateMessages (and serialized task writes)
    // for identical content.
    child.stdout.emit('data', Buffer.from('a\nb\nc\n'))
    await new Promise((r) => setTimeout(r, 0))
    expect(updates(h.events)).toHaveLength(1)
    expect(updates(h.events)[0].steps).toHaveLength(3)

    child.stdout.emit('data', Buffer.from('d\n'))
    await new Promise((r) => setTimeout(r, 0))
    expect(updates(h.events)).toHaveLength(2)

    child.stdout.emit('end')
    child.emit('close', 0)
    await done
  })

  it('carries a partial line across chunks', async () => {
    const h = harness()
    const done = runFlow(h, async (ctx) => {
      const child = ctx.spawn('agent', [])
      for await (const line of child.lines()) ctx.emit.message(line)
      return { exitCode: await child.exit }
    })
    await Promise.resolve()
    const child = h.spawns[0].child
    child.stdout.emit('data', Buffer.from('he'))
    child.stdout.emit('data', Buffer.from('llo\n'))
    await new Promise((r) => setTimeout(r, 0))
    child.stdout.emit('end')
    child.emit('close', 0)
    await done

    const texts = updates(h.events).flatMap((u) =>
      u.steps.map((s) => s.text),
    )
    expect(texts).toEqual(['hello'])
  })

  it('emits nothing for a batch that reduced to nothing', async () => {
    const h = harness()
    await runFlow(h, async () => ({ exitCode: 0 }))
    expect(updates(h.events)).toHaveLength(0)
    expect(h.events.map((e) => e.kind)).toEqual(['done'])
  })

  it('latches drivingModel and rateLimitResetsAt across later flushes', async () => {
    // The server's resume seq-dedupe skips already-applied updates, so a
    // one-shot value landing on a skipped seq would be unrecoverable after a
    // restart — losing, e.g., the scheduled-retry timestamp.
    const h = harness()
    const done = runFlow(h, async (ctx) => {
      const child = ctx.spawn('agent', [])
      let n = 0
      for await (const line of child.lines()) {
        if (n++ === 0)
          ctx.emit.meter({
            drivingModel: 'claude-opus-4-8',
            rateLimitResetsAt: '2026-01-01T01:00:00.000Z',
          })
        ctx.emit.message(line)
      }
      return { exitCode: await child.exit }
    })
    await Promise.resolve()
    const child = h.spawns[0].child
    child.stdout.emit('data', Buffer.from('one\n'))
    await new Promise((r) => setTimeout(r, 0))
    child.stdout.emit('data', Buffer.from('two\n'))
    await new Promise((r) => setTimeout(r, 0))
    child.stdout.emit('end')
    child.emit('close', 0)
    await done

    const us = updates(h.events)
    expect(us).toHaveLength(2)
    for (const u of us) {
      expect(u.drivingModel).toBe('claude-opus-4-8')
      expect(u.rateLimitResetsAt).toBe('2026-01-01T01:00:00.000Z')
    }
  })

  it('sets usageChanged only on a flush that saw new usage', async () => {
    const h = harness()
    const done = runFlow(h, async (ctx) => {
      const child = ctx.spawn('agent', [])
      let n = 0
      for await (const line of child.lines()) {
        if (n++ === 0)
          ctx.emit.meter({
            usage: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 },
          })
        ctx.emit.message(line)
      }
      return { exitCode: await child.exit }
    })
    await Promise.resolve()
    const child = h.spawns[0].child
    child.stdout.emit('data', Buffer.from('one\n'))
    await new Promise((r) => setTimeout(r, 0))
    child.stdout.emit('data', Buffer.from('two\n'))
    await new Promise((r) => setTimeout(r, 0))
    child.stdout.emit('end')
    child.emit('close', 0)
    await done

    const us = updates(h.events)
    expect(us[0].usageChanged).toBe(true)
    expect(us[0].usage).toMatchObject({ input: 1, output: 2 })
    expect(us[1].usageChanged).toBe(false)
    expect(us[1].usage).toBeUndefined()
  })
})

describe('ctx runtime — the done contract', () => {
  it('kills a still-running child when the flow returns', async () => {
    const h = harness()
    await runFlow(h, async (ctx) => {
      ctx.spawn('agent', [])
      // Return without waiting for the child — nothing downstream would reap it.
      return { exitCode: 0 }
    })
    expect(h.spawns[0].child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(h.events.at(-1)).toMatchObject({ kind: 'done', exitCode: 0 })
  })

  it('kills a still-running child when the flow throws, reporting exit 1', async () => {
    const h = harness()
    await runFlow(
      h,
      async (ctx) => {
        ctx.spawn('agent', [])
        throw new Error('flow blew up')
      },
      { tolerateThrow: true },
    )
    expect(h.spawns[0].child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(h.events.at(-1)).toMatchObject({
      kind: 'done',
      exitCode: 1,
      stderr: 'flow blew up',
    })
  })

  it('flushes pending emissions and state before the done', async () => {
    const h = harness()
    await runFlow(h, async (ctx) => {
      ctx.emit.message('trailing')
      ctx.state.set(['phase'], 'ended')
      return { exitCode: 0 }
    })
    expect(h.events.map((e) => e.kind)).toEqual([
      'update',
      'state-patch',
      'done',
    ])
  })

  it('kills every tracked child through killChildren (the host exit belt)', async () => {
    const h = harness()
    let a: FakeChild | undefined
    let b: FakeChild | undefined
    const done = runFlow(h, async (ctx) => {
      ctx.spawn('one', [])
      ctx.spawn('two', [])
      a = h.spawns[0].child
      b = h.spawns[1].child
      h.runtime.killChildren()
      return { exitCode: 0 }
    })
    await done
    expect(a!.kill).toHaveBeenCalled()
    expect(b!.kill).toHaveBeenCalled()
  })
})

describe('ctx runtime — spawn', () => {
  it('tees child stderr to the host even when the flow never reads it', async () => {
    // Load-bearing for liveness: the daemon arms the idle watchdog on host
    // stderr, and a stdout chunk reducing to an empty batch emits no HostEvent
    // at all — so stderr is sometimes the only activity signal crossing the
    // boundary. Without the tee an active agent is idle-killed at 10 minutes.
    const h = harness()
    const done = runFlow(h, async (ctx) => {
      const child = ctx.spawn('agent', [])
      // deliberately never reads child.stderr
      return { exitCode: await child.exit }
    })
    await Promise.resolve()
    const child = h.spawns[0].child
    child.stderr.emit('data', Buffer.from('agent noise\n'))
    child.emit('close', 0)
    await done
    expect(h.stderr.join('')).toContain('agent noise')
  })

  it('also delivers stderr lines to a flow that does read them', async () => {
    const h = harness()
    const seen: string[] = []
    const done = runFlow(h, async (ctx) => {
      const child = ctx.spawn('agent', [])
      const collect = (async () => {
        for await (const l of child.stderr) seen.push(l)
      })()
      const code = await child.exit
      await collect
      return { exitCode: code }
    })
    await Promise.resolve()
    const child = h.spawns[0].child
    child.stderr.emit('data', Buffer.from('warn one\nwarn two\n'))
    await new Promise((r) => setTimeout(r, 0))
    child.stderr.emit('end')
    child.emit('close', 0)
    await done
    expect(seen).toEqual(['warn one', 'warn two'])
    expect(h.stderr.join('')).toContain('warn one')
  })

  it('merges the flow env over the host env and defaults cwd to the run dir', async () => {
    const h = harness()
    await runFlow(h, async (ctx) => {
      ctx.spawn('agent', ['--x'], { env: { LANDER_FILES_DIR: '/files/t' } })
      return { exitCode: 0 }
    })
    const [call] = h.spawns
    expect(call.options.cwd).toBe('/repo')
    const env = call.options.env as Record<string, string>
    expect(env.LANDER_FILES_DIR).toBe('/files/t')
    expect(env.PATH).toBe(process.env.PATH)
    // Never detached: the supervisor's group SIGKILL reaches a spawned child
    // only through group membership.
    expect(call.options.detached).toBeUndefined()
  })
})

describe('ctx runtime — turn inputs', () => {
  it('splits the ungated filesDir from the existence-gated --add-dir signal', async () => {
    const h = harness(
      makeInput({}, { filesDir: '/definitely/not/a/real/dir/xyz' }),
    )
    await runFlow(h, async (ctx) => {
      // LANDER_FILES_DIR is set from filesDir with no existence check today, so
      // gating this field would diverge from the adapter on every task without
      // attachments. --add-dir is the one that needs the gate.
      expect(ctx.turn.filesDir).toBe('/definitely/not/a/real/dir/xyz')
      expect(ctx.turn.filesDirExists).toBe(false)
      return { exitCode: 0 }
    })
  })

  it('joins attachment refs with their materialized local paths', async () => {
    const h = harness(
      makeInput(
        {
          attachments: [
            { id: 'att1', name: 'shot.png', mime: 'image/png', size: 12 },
          ],
        },
        { filesDir: '/files/t' },
      ),
    )
    await runFlow(h, async (ctx) => {
      expect(ctx.turn.attachments).toEqual([
        {
          id: 'att1',
          name: 'shot.png',
          mime: 'image/png',
          size: 12,
          path: '/files/t/att1',
        },
      ])
      return { exitCode: 0 }
    })
  })

  it('exposes the launch snapshot the flow needs to build its argv', async () => {
    const h = harness(
      makeInput(
        {
          recordedCwd: '/repo/sub',
          task: { allowEdits: true, allow: ['Bash(npm test)'], worktree: 'feat' },
        },
        {
          reentryArgs: ['--worktree', 'feat'],
          effectiveCwd: '/repo/.claude/worktrees/feat',
        },
      ),
    )
    await runFlow(h, async (ctx) => {
      expect(ctx.task).toMatchObject({
        taskId: 'task-1',
        project: 'proj',
        root: '/repo',
        cwd: '/repo',
        reentryArgs: ['--worktree', 'feat'],
        effectiveCwd: '/repo/.claude/worktrees/feat',
        recordedCwd: '/repo/sub',
        allowEdits: true,
        allow: ['Bash(npm test)'],
        worktree: 'feat',
      })
      expect(ctx.turn.prompts).toEqual(['hello'])
      return { exitCode: 0 }
    })
  })
})

// `ctx.assist` is the one method on this surface that runs a real child process.
// It goes through `runAssist`, which spawns the provider itself rather than
// through the harness's injectable `spawn` — so the only faithful way to observe
// it is a PATH shim and a real cwd, the same instrument bin/lander-assist.test.ts
// uses on the CLI's copy of the same argv.
//
// It was uncovered until now: the commit that implemented it removed the
// assertion that it was unimplemented and added nothing in its place.
describe('ctx runtime — assist', () => {
  async function shim(): Promise<{
    dir: string
    log: string
    restore: () => Promise<void>
  }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'lander-ctx-assist-'))
    const log = path.join(dir, 'calls.jsonl')
    for (const command of ['claude', 'codex'] as const) {
      const file = path.join(dir, command)
      await writeFile(
        file,
        `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(
  ${JSON.stringify(log)},
  JSON.stringify({ command: ${JSON.stringify(command)}, args: process.argv.slice(2) }) + '\\n',
)
if (process.env.ASSIST_FAIL) {
  process.stderr.write('provider blew up\\n')
  process.exit(3)
}
process.stdout.write('  ${command} reply  \\n')
`,
      )
      await chmod(file, 0o755)
    }
    const priorPath = process.env.PATH
    process.env.PATH = `${dir}${path.delimiter}${priorPath ?? ''}`
    return {
      dir,
      log,
      restore: async () => {
        process.env.PATH = priorPath
        delete process.env.ASSIST_FAIL
        await rm(dir, { recursive: true, force: true })
      },
    }
  }

  const calls = async (log: string) =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { command: string; args: string[] })

  it('returns the trimmed reply, with the argv the write clamp builds', async () => {
    const s = await shim()
    try {
      // cwd must be a real directory: runAssist spawns the provider there.
      const h = harness(makeInput({}, { cwd: s.dir, root: s.dir }))
      await runFlow(h, async (ctx) => {
        const reply = await ctx.assist('summarize:', 'notes')
        // The flow contract is the reply itself, trimmed — not a result object.
        // A hook body gets the object, because it has to be able to report that
        // judgment was unavailable; a driver flow throws instead.
        expect(reply).toBe('claude reply')
        return { exitCode: 0 }
      })
      // Further arguments join on their own line, so `assist('summarize:', notes)`
      // reads the same here as through the CLI.
      expect(await calls(s.log)).toEqual([
        { command: 'claude', args: assistArgv('claude', 'summarize:\nnotes', {}).args },
      ])
    } finally {
      await s.restore()
    }
  })

  it('takes the provider from the task, so a codex task judges with codex', async () => {
    const s = await shim()
    try {
      const h = harness(
        makeInput({ agent: 'codex', flow: 'codex' }, { cwd: s.dir, root: s.dir }),
      )
      await runFlow(h, async (ctx) => {
        expect(await ctx.assist('ping')).toBe('codex reply')
        return { exitCode: 0 }
      })
      const [call] = await calls(s.log)
      expect(call).toEqual({
        command: 'codex',
        args: assistArgv('codex', 'ping', {}).args,
      })
      // Read-only, and the clamp precedes anything a profile could say.
      expect(call.args).toContain('--sandbox')
      expect(call.args[call.args.indexOf('--sandbox') + 1]).toBe('read-only')
    } finally {
      await s.restore()
    }
  })

  it('throws on a non-zero exit, rather than returning a failure', async () => {
    const s = await shim()
    process.env.ASSIST_FAIL = '1'
    try {
      const h = harness(makeInput({}, { cwd: s.dir, root: s.dir }))
      let thrown: unknown
      await runFlow(
        h,
        async (ctx) => {
          try {
            await ctx.assist('ping')
          } catch (e) {
            thrown = e
          }
          return { exitCode: 0 }
        },
      )
      // README documents a non-zero exit from assist as aborting the flow, and
      // this ctx's rule is that errors are thrown rather than exited on.
      expect(String(thrown)).toContain('assist:')
      expect(String(thrown)).toContain('provider blew up')
    } finally {
      await s.restore()
    }
  })

  it('throws naming the flow when that flow declares no one-shot provider', async () => {
    const s = await shim()
    try {
      // An announced flow is not a provider: it has no `agent`, and nothing
      // anywhere declares which one-shot it would want.
      const h = harness(
        makeInput({ agent: undefined, flow: 'open-pr' }, { cwd: s.dir, root: s.dir }),
      )
      let thrown: unknown
      await runFlow(h, async (ctx) => {
        try {
          await ctx.assist('ping')
        } catch (e) {
          thrown = e
        }
        return { exitCode: 0 }
      })
      expect(String(thrown)).toContain('open-pr')
      // And it never reached a provider.
      await expect(readFile(s.log, 'utf8')).rejects.toThrow()
    } finally {
      await s.restore()
    }
  })

  it('requires a prompt', async () => {
    const s = await shim()
    try {
      const h = harness(makeInput({}, { cwd: s.dir, root: s.dir }))
      let thrown: unknown
      await runFlow(h, async (ctx) => {
        try {
          await ctx.assist()
        } catch (e) {
          thrown = e
        }
        return { exitCode: 0 }
      })
      expect(String(thrown)).toContain('a prompt is required')
    } finally {
      await s.restore()
    }
  })
})

describe('ctx runtime — reserved v1 surface', () => {
  it('throws rather than silently no-oping on still-unimplemented methods', async () => {
    const h = harness()
    await runFlow(h, async (ctx) => {
      await expect(ctx.send()).rejects.toThrow('not implemented')
      await expect(ctx.list()).rejects.toThrow('not implemented')
      await expect(ctx.relaunch()).rejects.toThrow('not implemented')
      expect(() => ctx.telemetry.set([])).toThrow('not implemented')
      return { exitCode: 0 }
    })
  })

  it('reports scratch as cold-but-informed at v1', async () => {
    const h = harness()
    await runFlow(h, async (ctx) => {
      // No process can reliably stamp freshness yet (the host can be SIGKILLed
      // at ride end), and assuming cold is always correct.
      expect(ctx.scratch.fresh).toBe(false)
      expect(typeof ctx.scratch.dir).toBe('string')
      return { exitCode: 0 }
    })
  })
})

describe('ctx runtime — orchestration', () => {
  const API = 'http://api.test'
  const withApi = () =>
    harness(
      makeInput({
        env: {
          LANDER_API: API,
          LANDER_PROJECT: 'proj',
          LANDER_TASK: 'task-1',
          LANDER_TOKEN: 'tok',
        },
      }),
    )

  // Capture requests and answer them, standing in for the server.
  function fakeFetch(reply: unknown = { ok: true }) {
    const calls: { url: string; method: string; body: unknown }[] = []
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      })
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => reply,
        text: async () => JSON.stringify(reply),
      } as Response
    })
    vi.stubGlobal('fetch', fn)
    return calls
  }

  it('flushes BOTH buffers before an orchestration call', async () => {
    // The correctness rule, not hygiene. emit and state batch lazily and the
    // only mid-turn flush is a ctx.spawn drain — so a flow in an ask-only phase
    // that is killed after ctx.wedge would otherwise leave the user staring at
    // a wedge with buttons above an EMPTY ride, with its phase write lost.
    const h = withApi()
    const calls = fakeFetch({ ask: { id: 'ask-1' } })
    try {
      await runFlow(h, async (ctx) => {
        ctx.emit.message('collected the diff')
        ctx.state.set(['phase'], 'awaiting-approval')
        // Nothing on the wire yet — no spawn has drained.
        expect(updates(h.events)).toHaveLength(0)
        expect(patches(h.events)).toHaveLength(0)

        await ctx.wedge({ options: [{ id: 'go', label: 'Open PR' }] })

        // Both are out, and they were out BEFORE the request went.
        expect(updates(h.events).length).toBeGreaterThan(0)
        expect(patches(h.events)).toHaveLength(1)
        expect(patches(h.events)[0].ops[0]).toMatchObject({
          op: 'set',
          path: ['phase'],
          value: 'awaiting-approval',
        })
        expect(calls).toHaveLength(1)
        return { exitCode: 0 }
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('raises a task-blocking wedge and an advisory ask on the same route', async () => {
    const h = withApi()
    const calls = fakeFetch({ ask: { id: 'ask-1' } })
    try {
      await runFlow(h, async (ctx) => {
        await ctx.wedge({ options: [{ id: 'go', label: 'Go' }] })
        await ctx.ask({ options: [{ id: 'keep', label: 'Keep watching' }] })
        return { exitCode: 0 }
      })
      expect(calls[0].url).toBe(`${API}/api/proj/tasks/task-1/asks`)
      expect(calls[0].body).toMatchObject({ blocking: 'task' })
      expect(calls[1].body).toMatchObject({ blocking: 'none' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns the created ask so a caller can hold its id', async () => {
    const h = withApi()
    fakeFetch({ ask: { id: 'ask-42' } })
    try {
      await runFlow(h, async (ctx) => {
        const ask = await ctx.wedge({ options: [{ id: 'g', label: 'Go' }] })
        expect(ask).toMatchObject({ id: 'ask-42' })
        return { exitCode: 0 }
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reads a task through view, defaulting to its own', async () => {
    const h = withApi()
    const calls = fakeFetch({ id: 'task-1', items: [] })
    try {
      await runFlow(h, async (ctx) => {
        await ctx.view()
        await ctx.view('other-task')
        return { exitCode: 0 }
      })
      expect(calls[0].url).toBe(`${API}/api/proj/tasks/task-1`)
      expect(calls[1].url).toBe(`${API}/api/proj/tasks/other-task`)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('posts rest triggers and launches siblings with a flow and config', async () => {
    const h = withApi()
    const calls = fakeFetch({ id: 'sibling-1' })
    try {
      await runFlow(h, async (ctx) => {
        await ctx.rest({ time: 5 })
        await ctx.launch('fix the build', {
          flow: 'claude',
          config: { pr: 12 },
          edits: true,
        })
        return { exitCode: 0 }
      })
      expect(calls[0].url).toBe(`${API}/api/proj/tasks/task-1/rest`)
      expect(calls[0].body).toMatchObject({ time: 5 })
      expect(calls[1].body).toMatchObject({
        message: 'fix the build',
        flow: 'claude',
        flowConfig: { pr: 12 },
        allowEdits: true,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('throws on a failed call, and the turn settles as a failed done', async () => {
    // The v1 contract: errors are thrown, not process.exit — so a driver can
    // handle failure, and an unhandled one still settles the ride rather than
    // stranding the host.
    const h = withApi()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        json: async () => ({ error: 'only the task itself may raise its asks' }),
      })) as unknown as typeof fetch,
    )
    try {
      await runFlow(
        h,
        async (ctx) => {
          await ctx.wedge({ options: [{ id: 'g', label: 'Go' }] })
          return { exitCode: 0 }
        },
        { tolerateThrow: true },
      )
      const done = h.events.find((e) => e.kind === 'done')
      expect(done).toMatchObject({ exitCode: 1 })
      expect(JSON.stringify(done)).toContain('only the task itself')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('ctx runtime — durable state size cap', () => {
  it('throws at the write rather than letting the server drop a batch', async () => {
    // Enforcement must be host-side. applyStatePatch drops an over-cap batch
    // WITHOUT advancing flowStateRev, so the producer's next batch is strictly
    // greater and applies on top of the hole — while the host, having applied
    // the dropped ops locally, reasons over state the server never got.
    const h = harness()
    await runFlow(h, async (ctx) => {
      expect(() => ctx.state.set(['blob'], 'x'.repeat(STATE_MAX_BYTES + 1))).toThrow(
        /exceed/,
      )
      return { exitCode: 0 }
    })
  })

  it('leaves the local copy matching the server after a rejected write', async () => {
    // The whole point of failing atomically: if the local copy kept the
    // rejected value, the flow would reason over state the server never has.
    const h = harness()
    await runFlow(h, async (ctx) => {
      ctx.state.set(['phase'], 'collect')
      expect(() => ctx.state.set(['blob'], 'x'.repeat(STATE_MAX_BYTES + 1))).toThrow()
      expect(ctx.state.get(['blob'])).toBeUndefined()
      expect(ctx.state.get(['phase'])).toBe('collect')
      return { exitCode: 0 }
    })
    // And nothing over-cap reached the wire.
    for (const p of patches(h.events))
      expect(JSON.stringify(p).length).toBeLessThan(STATE_MAX_BYTES + 1000)
  })

  it('allows writes up to the cap', async () => {
    const h = harness()
    await runFlow(h, async (ctx) => {
      ctx.state.set(['blob'], 'x'.repeat(1000))
      expect(String(ctx.state.get(['blob'])).length).toBe(1000)
      return { exitCode: 0 }
    })
  })

  it('flush() puts a pending write on the wire without a spawn drain', async () => {
    // What a flow-authored setPhase() helper needs: state batches lazily and
    // the only mid-turn flush is a ctx.spawn drain, so a flow that never spawns
    // has no other way to make a phase write durable before a transition.
    const h = harness()
    await runFlow(h, async (ctx) => {
      ctx.state.set(['phase'], 'push')
      expect(patches(h.events)).toHaveLength(0)
      ctx.state.flush()
      expect(patches(h.events)).toHaveLength(1)
      expect(patches(h.events)[0].ops[0]).toMatchObject({ path: ['phase'] })
      return { exitCode: 0 }
    })
  })
})
