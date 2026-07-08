import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { createSupervisor } from './daemon-supervisor.mjs'

// Unit test for the daemon supervisor's respawn/handoff decisions, driven with a
// fake spawner and a deterministic clock — no real `tsx` processes. The fake child
// is an EventEmitter that records the last signal it was killed with and can be
// told to `exit`.

type FakeChild = EventEmitter & {
  kill: (sig?: string) => void
  killed?: string
  exit: (code?: number, signal?: string | null) => void
}

function makeHarness() {
  let nowMs = 0
  const timers = new Map<object, { fn: () => void; at: number }>()
  const setTimer = (fn: () => void, delay: number) => {
    const handle = { unref() {} }
    timers.set(handle, { fn, at: nowMs + delay })
    return handle
  }
  const clearTimer = (handle: object) => {
    timers.delete(handle)
  }
  // Advance the clock, firing every timer now due (in insertion order).
  const advance = (ms: number) => {
    nowMs += ms
    for (const [handle, t] of [...timers]) {
      if (t.at <= nowMs) {
        timers.delete(handle)
        t.fn()
      }
    }
  }

  const spawned: FakeChild[] = []
  const spawn = (): FakeChild => {
    const child = new EventEmitter() as FakeChild
    child.kill = (sig = 'SIGTERM') => {
      child.killed = sig
    }
    child.exit = (code = 0, signal: string | null = null) =>
      child.emit('exit', code, signal)
    spawned.push(child)
    return child
  }

  const logs: string[] = []
  const sup = createSupervisor({
    spawn,
    now: () => nowMs,
    setTimer,
    clearTimer,
    crashWindowMs: 3_000,
    respawnBackoffMs: 1_000,
    respawnBackoffMaxMs: 10_000,
    crashLoopThreshold: 3,
    maxDrainMs: 900_000,
    log: (m: string) => logs.push(m),
  })

  return { sup, spawned, advance, logs }
}

describe('daemon supervisor', () => {
  it('respawns the live daemon when it exits unexpectedly', () => {
    const { sup, spawned, advance } = makeHarness()
    sup.spawnDaemon()
    expect(spawned).toHaveLength(1)
    const d0 = sup.current as FakeChild
    d0.exit(1) // crash at t=0
    expect(sup.current).toBeNull()
    advance(999)
    expect(spawned).toHaveLength(1) // backoff (1s) not elapsed
    advance(1)
    expect(spawned).toHaveLength(2) // respawned
    expect(sup.current).toBe(spawned[1])
  })

  it('does not respawn a drained predecessor (reload hands off)', () => {
    const { sup, spawned, advance } = makeHarness()
    sup.spawnDaemon()
    const d0 = sup.current as FakeChild
    sup.reload()
    expect(d0.killed).toBe('SIGUSR1') // drained, not killed outright
    const d1 = sup.current
    expect(d1).not.toBe(d0)
    expect(spawned).toHaveLength(2)
    d0.exit(0) // the drained predecessor finishes
    advance(10_000)
    expect(spawned).toHaveLength(2) // no respawn
    expect(sup.current).toBe(d1)
  })

  it('does not respawn during shutdown', () => {
    const { sup, spawned, advance } = makeHarness()
    sup.spawnDaemon()
    const d0 = sup.current as FakeChild
    sup.shutdown()
    expect(d0.killed).toBe('SIGTERM')
    d0.exit(0, 'SIGTERM')
    advance(10_000)
    expect(spawned).toHaveLength(1)
  })

  it('backs off on a crash loop, then resets after a healthy run', () => {
    const { sup, spawned, advance } = makeHarness()
    sup.spawnDaemon() // d0 startedAt=0
    ;(sup.current as FakeChild).exit(1) // t=0 → crashes=1, delay=1000
    advance(1_000)
    expect(spawned).toHaveLength(2) // d1 startedAt=1000
    ;(sup.current as FakeChild).exit(1) // t=1000 → crashes=2, delay=2000
    advance(1_999)
    expect(spawned).toHaveLength(2) // 2s backoff not yet elapsed
    advance(1)
    expect(spawned).toHaveLength(3) // d2 startedAt=3000
    advance(5_000) // d2 runs healthily past the 3s crash window
    ;(sup.current as FakeChild).exit(1) // ran 5s ≥ window → crashes reset, delay=0
    advance(0)
    expect(spawned).toHaveLength(4) // immediate respawn
  })

  it('escalates to a crash-loop warning after consecutive fast crashes', () => {
    const { sup, logs, advance } = makeHarness()
    sup.spawnDaemon() // d0 startedAt=0
    ;(sup.current as FakeChild).exit(1) // t=0 → crashes=1, plain respawn line
    advance(1_000)
    ;(sup.current as FakeChild).exit(1) // t=1000 → crashes=2, plain respawn line
    advance(2_000)
    // First two crashes stay below the threshold: no escalation yet.
    expect(logs.some((l) => l.includes('CRASH LOOP'))).toBe(false)
    ;(sup.current as FakeChild).exit(1) // t=3000 → crashes=3 → escalates
    expect(logs.some((l) => l.includes('CRASH LOOP'))).toBe(true)
  })

  it('a reload clears crash-loop backoff state (an applied fix recovers cleanly)', () => {
    const { sup, logs, advance } = makeHarness()
    sup.spawnDaemon() // d0 startedAt=0
    ;(sup.current as FakeChild).exit(1) // t=0 → crashes=1
    advance(1_000)
    ;(sup.current as FakeChild).exit(1) // t=1000 → crashes=2
    advance(2_000) // d2 spawned
    expect(sup.crashes).toBe(2)
    sup.reload() // fix applied: drains d2, spawns fresh, crash state cleared
    expect(sup.crashes).toBe(0)
    ;(sup.current as FakeChild).exit(1) // counts from a clean slate, not 3
    expect(sup.crashes).toBe(1)
    expect(logs.some((l) => l.includes('CRASH LOOP'))).toBe(false)
  })

  it('a reload during the backoff window does not double-spawn', () => {
    const { sup, spawned, advance } = makeHarness()
    sup.spawnDaemon()
    ;(sup.current as FakeChild).exit(1) // crashes=1, delay=1000, current=null
    expect(sup.current).toBeNull()
    sup.reload() // current===null → spawns a fresh daemon immediately
    expect(spawned).toHaveLength(2)
    const d1 = sup.current
    advance(1_000) // the backoff timer fires but current!==null now
    expect(spawned).toHaveLength(2)
    expect(sup.current).toBe(d1)
  })
})
