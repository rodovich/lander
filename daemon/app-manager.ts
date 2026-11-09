// Starts and stops the apps lander runs for a checkout. An app outlives the
// daemon that started it, so the registry file is its record and each operation
// reads it afresh, which lets a replacement daemon take over with no handoff.

import { execFile, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { scrubbedEnv } from '../server/secrets'
import { isListening as probeListening } from './apps'
import { isSafePathSegment } from './paths'
import { signalProcessGroup } from './processes'

const STOP_POLL_MS = 100

export type AppEntry = {
  project: string
  // The task id for a worktree, or `root` for a project's main checkout.
  key: string
  checkout: string
  pid: number
  // Pairs with `pid` to identify the process, since pids get reused.
  processStart: string
  startedAt: number
  leaseUntil: number
  everListened: boolean
  state: 'running' | 'stopping' | 'exited'
}

export type AppStart = {
  project: string
  key: string
  checkout: string
  command: string[]
  leaseMs: number
}

export type StartResult =
  | { ok: true; entry: AppEntry }
  | { ok: false; reason: 'already-running' | 'port-in-use' | 'cannot-start'; error?: string }

export type AppManagerDeps = {
  registryFile: string
  logDir: string
  maxApps: number
  stopGraceMs: number
  // The URL can appear after start, when setup writes the file it comes from.
  resolveUrl: (entry: Pick<AppEntry, 'project' | 'checkout'>) => string | undefined
  isListening?: (url: string) => Promise<boolean>
  now?: () => number
  // A process's start time, null if there is no such process, or undefined if
  // that couldn't be determined.
  processStart?: (pid: number) => Promise<string | null | undefined>
  signalGroup?: (pid: number, signal: NodeJS.Signals) => void
}

// Fixed zone and locale, since `lstart` is formatted with them and a replacement
// daemon must read the same text for the same process.
function psProcessStart(pid: number): Promise<string | null | undefined> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { timeout: 2_000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } },
      (err, out) => {
        const start = String(out).trim()
        if (start) resolve(start)
        else resolve(!err || err.code === 1 ? null : undefined)
      },
    )
  })
}

export function createAppManager(deps: AppManagerDeps) {
  const now = deps.now ?? Date.now
  const isListening = deps.isListening ?? probeListening
  const processStart = deps.processStart ?? psProcessStart
  const signalGroup = deps.signalGroup ?? signalProcessGroup
  const stopsInFlight = new Set<string>()
  let startQueue: Promise<unknown> = Promise.resolve()

  const idOf = (a: Pick<AppEntry, 'project' | 'key'>) => `${a.project}\0${a.key}`

  function read(): AppEntry[] {
    let text: string
    try {
      text = readFileSync(deps.registryFile, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    return (JSON.parse(text) as { apps: AppEntry[] }).apps
  }

  function write(apps: AppEntry[]): void {
    mkdirSync(path.dirname(deps.registryFile), { recursive: true })
    const tmp = `${deps.registryFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ apps }, null, 2))
    renameSync(tmp, deps.registryFile)
  }

  const get = (project: string, key: string) =>
    read().find((a) => a.project === project && a.key === key)

  const sameApp = (a: AppEntry, b: AppEntry) => idOf(a) === idOf(b) && a.pid === b.pid

  function update(entry: AppEntry, change: Partial<AppEntry>): void {
    write(read().map((a) => (sameApp(a, entry) ? { ...a, ...change } : a)))
  }

  function remove(entry: AppEntry): void {
    write(read().filter((a) => !sameApp(a, entry)))
  }

  function logFile(project: string, key: string): string {
    if (!isSafePathSegment(project) || !isSafePathSegment(key))
      throw new Error(`unsafe app name: ${project}/${key}`)
    return path.join(deps.logDir, project, `${key}.log`)
  }

  async function identify(entry: AppEntry): Promise<'ours' | 'other' | 'gone' | 'unknown'> {
    const start = await processStart(entry.pid)
    if (start === undefined) return 'unknown'
    if (start === null) return 'gone'
    return start === entry.processStart ? 'ours' : 'other'
  }

  function spawned(command: string, args: string[], cwd: string, fd: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        detached: true,
        env: scrubbedEnv(),
        stdio: ['ignore', fd, fd],
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve(child.pid!)
      })
    })
  }

  async function launch(spec: AppStart): Promise<StartResult> {
    const [command, ...args] = spec.command
    let pid: number | undefined
    let fd: number | undefined
    try {
      const log = logFile(spec.project, spec.key)
      mkdirSync(path.dirname(log), { recursive: true })
      fd = openSync(log, 'w')
      pid = await spawned(command, args, spec.checkout, fd)
      const start = await processStart(pid)
      if (start === undefined) throw new Error('could not identify the started process')
      const startedAt = now()
      const entry: AppEntry = {
        project: spec.project,
        key: spec.key,
        checkout: spec.checkout,
        pid,
        processStart: start ?? '',
        startedAt,
        leaseUntil: startedAt + spec.leaseMs,
        everListened: false,
        state: start === null ? 'exited' : 'running',
      }
      write([...read().filter((a) => idOf(a) !== idOf(spec)), entry])
      return { ok: true, entry }
    } catch (e) {
      if (pid) signalGroup(pid, 'SIGKILL')
      return {
        ok: false,
        reason: 'cannot-start',
        error: e instanceof Error ? e.message : String(e),
      }
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  async function startNow(spec: AppStart): Promise<StartResult> {
    const existing = get(spec.project, spec.key)
    if (existing && existing.state !== 'exited') return { ok: false, reason: 'already-running' }
    const url = deps.resolveUrl(spec)
    if (url && (await isListening(url))) return { ok: false, reason: 'port-in-use' }
    const result = await launch(spec)
    if (!result.ok) return result
    const others = read()
      .filter((a) => a.state === 'running' && idOf(a) !== idOf(spec))
      .sort((a, b) => a.leaseUntil - b.leaseUntil)
    for (const app of others.slice(0, Math.max(0, others.length + 1 - deps.maxApps)))
      await stop(app.project, app.key)
    return result
  }

  // One at a time, so that concurrent starts can't overshoot the cap.
  function start(spec: AppStart): Promise<StartResult> {
    const result = startQueue.then(() => startNow(spec))
    startQueue = result.catch(() => {})
    return result
  }

  async function waitForExit(entry: AppEntry): Promise<void> {
    const deadline = performance.now() + deps.stopGraceMs
    while (performance.now() < deadline) {
      const who = await identify(entry)
      if (who === 'gone' || who === 'other') return
      await new Promise((done) => setTimeout(done, STOP_POLL_MS))
    }
  }

  // Also takes down children left behind by a leader that has gone.
  async function killGroup(entry: AppEntry): Promise<'done' | 'unknown'> {
    const who = await identify(entry)
    if (who === 'unknown') return 'unknown'
    if (who !== 'other') signalGroup(entry.pid, 'SIGKILL')
    return 'done'
  }

  async function stop(project: string, key: string): Promise<boolean> {
    const entry = get(project, key)
    if (!entry || stopsInFlight.has(idOf(entry))) return false
    if (entry.state === 'exited') {
      remove(entry)
      return true
    }
    stopsInFlight.add(idOf(entry))
    try {
      update(entry, { state: 'stopping' })
      const who = await identify(entry)
      if (who === 'ours' || who === 'unknown') {
        if (who === 'ours') signalGroup(entry.pid, 'SIGTERM')
        await waitForExit(entry)
      }
      // Left as `stopping` when unknown, for the sweep to finish.
      if ((await killGroup(entry)) === 'unknown') return false
      remove(entry)
      return true
    } finally {
      stopsInFlight.delete(idOf(entry))
    }
  }

  async function sweepEntry(snapshot: AppEntry): Promise<void> {
    const who = await identify(snapshot)
    if (who === 'unknown') return
    const entry = read().find((a) => sameApp(a, snapshot))
    if (!entry || stopsInFlight.has(idOf(entry))) return
    if (who !== 'ours') {
      await killGroup(entry)
      if (entry.state === 'stopping') remove(entry)
      else update(entry, { state: 'exited' })
    } else if (entry.state === 'stopping') {
      signalGroup(entry.pid, 'SIGKILL')
    } else if (entry.leaseUntil <= now()) {
      await stop(entry.project, entry.key)
    } else if (!entry.everListened) {
      const url = deps.resolveUrl(entry)
      if (url && (await isListening(url))) update(entry, { everListened: true })
    }
  }

  async function sweep(): Promise<void> {
    for (const entry of read())
      if (entry.state !== 'exited' && !stopsInFlight.has(idOf(entry))) await sweepEntry(entry)
  }

  async function stopAll(): Promise<void> {
    await Promise.all(read().map((a) => stop(a.project, a.key)))
  }

  function extend(project: string, key: string, ms: number): void {
    const entry = get(project, key)
    if (entry?.state === 'running')
      update(entry, { leaseUntil: Math.max(entry.leaseUntil, now() + ms) })
  }

  return { start, stop, stopAll, sweep, extend, get, list: read, logFile }
}
