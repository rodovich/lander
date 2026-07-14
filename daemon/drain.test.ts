import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDrain } from './drain'

// Unit tests for the drain exit condition daemon/index.ts wires to SIGUSR2:
// exit only when draining AND no runs are held AND no settle-sweep is in flight,
// abandoning a stuck sweep once the grace lapses. Fake timers drive the tick
// loop and the grace clock.

describe('drain', () => {
  afterEach(() => vi.useRealTimers())

  function make(state: { runs: number; sweeping: boolean }, graceMs = 5_000) {
    const stopTimers = vi.fn()
    const exit = vi.fn()
    const drain = createDrain({
      runsHeld: () => state.runs,
      sweepInFlight: () => state.sweeping,
      stopTimers,
      exit,
      graceMs,
    })
    return { drain, stopTimers, exit }
  }

  it('is inert before begin: check() never exits, timers keep running', () => {
    vi.useFakeTimers()
    const { drain, stopTimers, exit } = make({ runs: 0, sweeping: false })
    drain.check()
    vi.advanceTimersByTime(10_000)
    expect(drain.draining()).toBe(false)
    expect(stopTimers).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('stops the watch timers at begin (SIGUSR2) and exits once, immediately, when idle', () => {
    vi.useFakeTimers()
    const { drain, stopTimers, exit } = make({ runs: 0, sweeping: false })
    drain.begin()
    expect(stopTimers).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
    // The tick loop stopped with the exit — no repeat calls.
    vi.advanceTimersByTime(10_000)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('waits for held runs; the onEmpty nudge (check) exits without a tick', () => {
    vi.useFakeTimers()
    const state = { runs: 2, sweeping: false }
    const { drain, exit } = make(state)
    drain.begin()
    vi.advanceTimersByTime(1_000)
    expect(exit).not.toHaveBeenCalled()
    state.runs = 0
    drain.check() // the run manager's onEmpty nudge
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('waits for an in-flight settle-sweep, exiting on the tick after it finishes', () => {
    vi.useFakeTimers()
    const state = { runs: 0, sweeping: true }
    const { drain, exit } = make(state)
    drain.begin()
    vi.advanceTimersByTime(1_000)
    expect(exit).not.toHaveBeenCalled() // sweep holds the drain open
    state.sweeping = false
    vi.advanceTimersByTime(200)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('abandons a stuck sweep once DRAIN_SWEEP_GRACE_MS lapses', () => {
    vi.useFakeTimers()
    const state = { runs: 0, sweeping: true }
    const { drain, exit } = make(state, 5_000)
    drain.begin()
    vi.advanceTimersByTime(4_800)
    expect(exit).not.toHaveBeenCalled() // still inside the grace
    vi.advanceTimersByTime(400)
    expect(exit).toHaveBeenCalledTimes(1) // grace lapsed — exit anyway
  })

  it('begin is idempotent: the grace deadline is not re-armed', () => {
    vi.useFakeTimers()
    const state = { runs: 0, sweeping: true }
    const { drain, stopTimers, exit } = make(state, 5_000)
    drain.begin()
    vi.advanceTimersByTime(4_000)
    drain.begin() // a second SIGUSR2 must not push the deadline out
    expect(stopTimers).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1_200)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('a run held past the grace still blocks the exit (grace bounds sweeps only)', () => {
    vi.useFakeTimers()
    const state = { runs: 1, sweeping: false }
    const { drain, exit } = make(state, 5_000)
    drain.begin()
    vi.advanceTimersByTime(60_000)
    expect(exit).not.toHaveBeenCalled()
    state.runs = 0
    vi.advanceTimersByTime(200)
    expect(exit).toHaveBeenCalledTimes(1)
  })
})
