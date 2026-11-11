import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppManager, type AppManagerDeps } from './app-manager'

const until = (check: () => boolean | Promise<boolean>) =>
  vi.waitUntil(check, { timeout: 8_000, interval: 20 })

const running = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('app manager', { timeout: 15_000 }, () => {
  let dir: string
  let managers: ReturnType<typeof createAppManager>[]

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'lander-app-manager-')))
    managers = []
  })
  afterEach(async () => {
    await managers[0]?.stopAll()
    rmSync(dir, { recursive: true, force: true })
  })

  const manager = (over: Partial<AppManagerDeps> = {}) => {
    const m = createAppManager({
      registryFile: path.join(dir, 'apps.json'),
      logDir: path.join(dir, 'logs'),
      maxApps: () => 3,
      stopGraceMs: 300,
      resolveUrl: () => undefined,
      ...over,
    })
    managers.push(m)
    return m
  }

  const script = (name: string, body: string) => {
    const file = path.join(dir, name)
    writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return file
  }

  const spec = (key: string, command: string, leaseMs = 60_000) => ({
    project: 'proj',
    key,
    taskId: key,
    checkout: dir,
    command: [command],
    leaseMs,
  })

  const sleeper = () => {
    const file = path.join(dir, 'sleeper')
    if (!existsSync(file)) script('sleeper', 'exec sleep 30')
    return file
  }

  const entryFile = (over: object = {}) =>
    writeFileSync(
      path.join(dir, 'apps.json'),
      JSON.stringify({
        apps: [
          {
            project: 'proj',
            key: 't1',
            taskId: 't1',
            checkout: dir,
            pid: 4242,
            processStart: 'ours',
            startedAt: 0,
            leaseUntil: Number.MAX_SAFE_INTEGER,
            everListened: true,
            state: 'running',
            ...over,
          },
        ],
      }),
    )

  it('starts the command in the checkout with its output in a log and no lander tokens', async () => {
    const m = manager()
    vi.stubEnv('LANDER_DAEMON_TOKEN', 'secret')
    const result = await m.start(
      spec('t1', script('app', 'echo "$PWD [$LANDER_DAEMON_TOKEN]"; exec sleep 30')),
    )
    vi.unstubAllEnvs()
    expect(result.ok).toBe(true)
    const log = m.logFile('proj', 't1')
    await until(() => readFileSync(log, 'utf8').includes(dir))
    expect(readFileSync(log, 'utf8').trim()).toBe(`${dir} []`)
  })

  it('gives the app the environment asked for its start', async () => {
    const m = manager()
    const result = await m.start({
      ...spec('t1', script('app', 'echo "[$APP_TASK]"; exec sleep 30')),
      env: { APP_TASK: 'task t1' },
    })
    expect(result.ok).toBe(true)
    const log = m.logFile('proj', 't1')
    await until(() => readFileSync(log, 'utf8').includes('['))
    expect(readFileSync(log, 'utf8').trim()).toBe('[task t1]')
  })

  it('lets a new manager find and stop an app the previous one started', async () => {
    const first = manager()
    const result = await first.start(spec('t1', sleeper()))
    if (!result.ok) throw new Error('did not start')

    const second = manager()
    expect(second.get('proj', 't1')?.pid).toBe(result.entry.pid)
    await second.sweep()
    expect(second.get('proj', 't1')?.state).toBe('running')
    expect(await second.stop('proj', 't1')).toBe(true)
    await until(() => !running(result.entry.pid))
    expect(second.list()).toEqual([])
  })

  it('stops children in the process group, and kills what ignores SIGTERM', async () => {
    const pidFile = path.join(dir, 'child.pid')
    const m = manager()
    const result = await m.start(
      spec('t1', script('app', `trap '' TERM; sleep 30 & echo $! > ${pidFile}; wait`)),
    )
    if (!result.ok) throw new Error('did not start')
    await until(() => {
      try {
        return readFileSync(pidFile, 'utf8').trim() !== ''
      } catch {
        return false
      }
    })
    const child = Number(readFileSync(pidFile, 'utf8'))
    await m.stop('proj', 't1')
    await until(() => !running(result.entry.pid) && !running(child))
  })

  it('records an exit on the sweep and keeps it until the next start', async () => {
    const m = manager()
    await m.start(spec('t1', script('app', 'exit 3')))
    await until(async () => {
      await m.sweep()
      return m.get('proj', 't1')?.state === 'exited'
    })
    expect((await m.start(spec('t1', sleeper()))).ok).toBe(true)
    expect(m.get('proj', 't1')?.state).toBe('running')
  })

  it('refuses a second start of a running app', async () => {
    const m = manager()
    await m.start(spec('t1', sleeper()))
    expect(await m.start(spec('t1', sleeper()))).toEqual({
      ok: false,
      reason: 'already-running',
    })
  })

  it('refuses to start when something already listens on the port', async () => {
    const m = manager({
      resolveUrl: () => 'http://localhost:1234',
      isListening: async () => true,
    })
    expect(await m.start(spec('t1', sleeper()))).toEqual({ ok: false, reason: 'port-in-use' })
    expect(m.list()).toEqual([])
  })

  it('reports a command that cannot run', async () => {
    const m = manager()
    const result = await m.start(spec('t1', path.join(dir, 'missing')))
    expect(result).toMatchObject({ ok: false, reason: 'cannot-start' })
    expect(m.list()).toEqual([])
  })

  it('stops the app with the soonest expiry when the cap is reached', async () => {
    let clock = 1_000
    const m = manager({ maxApps: () => 2, now: () => clock })
    await m.start(spec('late', sleeper(), 60_000))
    await m.start(spec('soon', sleeper(), 10_000))
    clock += 1
    await m.start(spec('new', sleeper(), 60_000))
    expect(m.list().map((a) => a.key).sort()).toEqual(['late', 'new'])
  })

  it('stops an app whose lease has expired, unless it was extended', async () => {
    let clock = 1_000
    const m = manager({ now: () => clock })
    await m.start(spec('t1', sleeper(), 1_000))
    await m.start(spec('t2', sleeper(), 1_000))
    m.extend('proj', 't2', 5_000)
    clock += 1_000
    await m.sweep()
    expect(m.list().map((a) => a.key)).toEqual(['t2'])
  })

  it('forgets an exited app once its lease has passed', async () => {
    let clock = 1_000
    const m = manager({ now: () => clock, processStart: async () => null })
    entryFile({ state: 'exited', leaseUntil: 2_000 })
    await m.sweep()
    expect(m.list()).toHaveLength(1)
    clock = 2_000
    await m.sweep()
    expect(m.list()).toEqual([])
  })

  it('reads the end of an app’s log', async () => {
    const m = manager()
    expect(m.logTail('proj', 't1')).toBe('')
    await m.start(
      spec('t1', script('app', 'for i in $(seq 1 300); do echo line$i; done; exec sleep 30')),
    )
    await until(() => m.logTail('proj', 't1').includes('line300'))
    const lines = m.logTail('proj', 't1').split('\n')
    expect(lines[0]).toBe('line101')
    expect(lines.at(-1)).toBe('line300')
  })

  it('shows an exited app as gone once something else listens on its port', async () => {
    const m = manager({ processStart: async () => null })
    entryFile({ state: 'exited' })
    expect(m.describe('proj', 't1', false)?.phase).toBe('failed')
    expect(m.describe('proj', 't1', true)).toBeUndefined()
  })

  it('keeps an app whose ride is in progress past its lease, and out of the cap', async () => {
    let clock = 1_000
    const m = manager({ maxApps: () => 1, now: () => clock })
    await m.start(spec('riding', sleeper(), 1_000))
    m.hold('proj', 'riding', 5_000)
    clock += 2_000
    await m.sweep()
    expect(m.get('proj', 'riding')?.state).toBe('running')
    await m.start(spec('new', sleeper()))
    expect(m.list().map((a) => a.key).sort()).toEqual(['new', 'riding'])
    clock += 5_000
    await m.sweep()
    expect(m.list().map((a) => a.key)).toEqual(['new'])
  })

  it('notes when the port first opens', async () => {
    let listening = false
    const m = manager({
      resolveUrl: () => 'http://localhost:1234',
      isListening: async () => listening,
    })
    await m.start(spec('t1', sleeper()))
    await m.sweep()
    expect(m.get('proj', 't1')?.everListened).toBe(false)
    listening = true
    await m.sweep()
    expect(m.get('proj', 't1')?.everListened).toBe(true)
  })

  it('never signals a different process that has reused the pid', async () => {
    const signalGroup = vi.fn()
    const m = manager({ signalGroup, processStart: async () => 'someone else' })
    entryFile()
    await m.sweep()
    expect(signalGroup).not.toHaveBeenCalled()
    expect(m.get('proj', 't1')?.state).toBe('exited')
    await m.stop('proj', 't1')
    expect(signalGroup).not.toHaveBeenCalled()
  })

  it('leaves an app alone when it cannot tell whether the process is alive', async () => {
    const signalGroup = vi.fn()
    const m = manager({ signalGroup, processStart: async () => undefined })
    entryFile()
    await m.sweep()
    expect(signalGroup).not.toHaveBeenCalled()
    expect(m.get('proj', 't1')?.state).toBe('running')
  })

  it('kills and refuses an app it cannot identify after starting it', async () => {
    const signalGroup = vi.fn()
    const m = manager({ signalGroup, processStart: async () => undefined })
    const result = await m.start(spec('t1', sleeper()))
    expect(result).toMatchObject({ ok: false, reason: 'cannot-start' })
    expect(signalGroup).toHaveBeenCalledWith(expect.any(Number), 'SIGKILL')
    process.kill(-signalGroup.mock.calls[0][0], 'SIGKILL')
    expect(m.list()).toEqual([])
  })

  it('gives a stopping app its full grace period despite a sweep', async () => {
    const signals: string[] = []
    const m = manager({
      signalGroup: (_pid, signal) => signals.push(signal),
      processStart: async () => 'ours',
    })
    entryFile()
    const stopping = m.stop('proj', 't1')
    await until(() => signals.length === 1)
    await m.sweep()
    expect(signals).toEqual(['SIGTERM'])
    await stopping
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('finishes a stop that a previous daemon left unfinished', async () => {
    const signalGroup = vi.fn()
    let start: string | null = 'ours'
    const m = manager({ signalGroup, processStart: async () => start })
    entryFile({ state: 'stopping' })
    await m.sweep()
    expect(signalGroup).toHaveBeenCalledWith(4242, 'SIGKILL')
    start = null
    await m.sweep()
    expect(m.list()).toEqual([])
  })

  it('refuses a start while the previous app is still stopping', async () => {
    const m = manager({ processStart: async () => 'ours', signalGroup: () => {} })
    entryFile({ state: 'stopping' })
    expect(await m.start(spec('t1', sleeper()))).toEqual({
      ok: false,
      reason: 'already-running',
    })
  })

  it('does not exceed the cap when starts overlap', async () => {
    const m = manager({ maxApps: () => 1 })
    await Promise.all([m.start(spec('a', sleeper())), m.start(spec('b', sleeper()))])
    expect(m.list().filter((a) => a.state === 'running')).toHaveLength(1)
  })

  it('leaves other apps running when a start fails', async () => {
    const m = manager({ maxApps: () => 1 })
    await m.start(spec('a', sleeper()))
    await m.start(spec('b', path.join(dir, 'missing')))
    expect(m.list().map((a) => a.key)).toEqual(['a'])
  })

  it('refuses to treat an unreadable registry as empty', () => {
    writeFileSync(path.join(dir, 'apps.json'), '{ half')
    expect(() => manager().list()).toThrow()
    rmSync(path.join(dir, 'apps.json'))
  })

  it('refuses a name that could walk out of the log directory', () => {
    expect(() => manager().logFile('proj', '../x')).toThrow(/unsafe app name/)
  })
})
