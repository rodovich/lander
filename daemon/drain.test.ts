import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDrain } from './drain'

// Unit tests for the drain exit condition daemon/index.ts wires to SIGUSR2:
// exit only when draining AND no runs are held. Fake timers drive the tick loop.

describe('drain', () => {
  afterEach(() => vi.useRealTimers())

  function make(state: { runs: number }) {
    const exit = vi.fn()
    const drain = createDrain({
      runsHeld: () => state.runs,
      exit,
    })
    return { drain, exit }
  }

  it('is inert before begin: check() never exits, timers keep running', () => {
    vi.useFakeTimers()
    const { drain, exit } = make({ runs: 0 })
    drain.check()
    vi.advanceTimersByTime(10_000)
    expect(drain.draining()).toBe(false)
    expect(exit).not.toHaveBeenCalled()
  })

  it('exits once, immediately, when begin (SIGUSR2) finds it idle', () => {
    vi.useFakeTimers()
    const { drain, exit } = make({ runs: 0 })
    drain.begin()
    expect(exit).toHaveBeenCalledTimes(1)
    // The tick loop stopped with the exit — no repeat calls.
    vi.advanceTimersByTime(10_000)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('waits for held runs; the onEmpty nudge (check) exits without a tick', () => {
    vi.useFakeTimers()
    const state = { runs: 2 }
    const { drain, exit } = make(state)
    drain.begin()
    vi.advanceTimersByTime(1_000)
    expect(exit).not.toHaveBeenCalled()
    state.runs = 0
    drain.check() // the run manager's onEmpty nudge
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('exits on the tick after the last held run drops', () => {
    vi.useFakeTimers()
    const state = { runs: 1 }
    const { drain, exit } = make(state)
    drain.begin()
    vi.advanceTimersByTime(60_000)
    expect(exit).not.toHaveBeenCalled() // a held run blocks the exit indefinitely
    state.runs = 0
    vi.advanceTimersByTime(200)
    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('begin is idempotent: a second SIGUSR2 changes nothing', () => {
    vi.useFakeTimers()
    const state = { runs: 1 }
    const { drain, exit } = make(state)
    drain.begin()
    vi.advanceTimersByTime(1_000)
    drain.begin()
    expect(drain.draining()).toBe(true)
    expect(exit).not.toHaveBeenCalled()
    state.runs = 0
    vi.advanceTimersByTime(200)
    expect(exit).toHaveBeenCalledTimes(1)
  })
})
