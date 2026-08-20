// The one-shot both a hook body and a driver flow reason through.
//
// Driven with an injected spawn: the real thing shells out to a provider, which
// costs money, needs credentials, and would make a pre-commit gate depend on a
// network round trip.

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { assistArgv, runAssist } from './assist'

// A child whose streams and exit the test drives.
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { end: () => void; on: () => void }
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: () => {}, on: () => {} }
  child.kill = vi.fn()
  return child
}

function harness(over: Partial<Parameters<typeof runAssist>[0]> = {}) {
  const child = fakeChild()
  const calls: { command: string; args: string[]; opts: { cwd?: string } }[] = []
  const spawnChild = ((command: string, args: string[], opts: { cwd?: string }) => {
    calls.push({ command, args, opts })
    return child
  }) as unknown as Parameters<typeof runAssist>[0]['spawnChild']
  const promise = runAssist({
    provider: 'claude',
    prompt: 'is this finished?',
    cwd: '/tmp/project',
    spawnChild,
    ...over,
  })
  return { child, calls, promise }
}

describe('assistArgv', () => {
  it('passes the prompt after `--`, so one starting with a hyphen is a prompt', () => {
    const { command, args } = assistArgv('claude', '--not-a-flag', {})
    expect(command).toBe('claude')
    expect(args).toEqual(['-p', '--', '--not-a-flag'])
  })

  // Without these an instance whose Codex model or credentials live in a lander
  // profile gets a differently-configured call, or none at all.
  it('carries the deployment’s Codex profile and config overrides', () => {
    const { command, args } = assistArgv('codex', 'judge this', {
      LANDER_CODEX_PROFILE: 'lander-read-only',
      LANDER_CODEX_CONFIG: 'model="gpt-5"\nfoo="bar"',
    })
    expect(command).toBe('codex')
    expect(args).toEqual([
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--profile',
      'lander-read-only',
      '--config',
      'model="gpt-5"',
      '--config',
      'foo="bar"',
      '--',
      'judge this',
    ])
  })

  // Probed: at a project root `codex exec` defaults to workspace-write and
  // reports WRITE=yes. Claude grants no write in a one-shot, so without this the
  // same hook would be able to modify the repository under one provider and not
  // the other — which is the neutrality this verb exists to provide.
  it('does not let a Codex judge inherit write access to the target', () => {
    const { args } = assistArgv('codex', 'x', {})
    expect(args.slice(0, 3)).toEqual(['exec', '--sandbox', 'read-only'])
  })

  // A project need not be a git repository, and Codex refuses a directory that
  // is not one unless told otherwise — probed directly.
  it('does not require the project to be a git repository', () => {
    expect(assistArgv('codex', 'x', {}).args).toContain('--skip-git-repo-check')
  })
})

describe('runAssist', () => {
  it('returns the reply, trimmed, on a clean exit', async () => {
    const { child, promise } = harness()
    child.stdout.emit('data', Buffer.from('  not finished\n\n'))
    child.emit('close', 0)
    expect(await promise).toEqual({ ok: true, text: 'not finished' })
  })

  it('runs where the caller said, not where the host happens to stand', async () => {
    const { child, calls, promise } = harness({ cwd: '/tmp/somewhere-else' })
    child.emit('close', 0)
    await promise
    expect(calls[0].opts.cwd).toBe('/tmp/somewhere-else')
  })

  // A body must be able to report that judgment was unavailable, so none of
  // these throw and none of them exit the process.
  it('reports a non-zero exit as a result rather than throwing', async () => {
    const { child, promise } = harness()
    child.stderr.emit('data', Buffer.from('credentials missing'))
    child.emit('close', 1)
    expect(await promise).toEqual({ ok: false, error: 'credentials missing' })
  })

  it('reports a provider that cannot be launched at all', async () => {
    const spawnChild = (() => {
      throw new Error('ENOENT')
    }) as unknown as Parameters<typeof runAssist>[0]['spawnChild']
    expect(
      await runAssist({ provider: 'claude', prompt: 'x', cwd: '/tmp', spawnChild }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('ENOENT') })
  })

  it('kills and reports a provider that never answers', async () => {
    vi.useFakeTimers()
    try {
      const { child, promise } = harness({ timeoutMs: 1000 })
      vi.advanceTimersByTime(1001)
      const result = await promise
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining('did not answer'),
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles once, even if the child closes after its timeout fired', async () => {
    vi.useFakeTimers()
    try {
      const { child, promise } = harness({ timeoutMs: 1000 })
      vi.advanceTimersByTime(1001)
      child.stdout.emit('data', Buffer.from('late answer'))
      child.emit('close', 0)
      expect(await promise).toMatchObject({ ok: false })
    } finally {
      vi.useRealTimers()
    }
  })
})
