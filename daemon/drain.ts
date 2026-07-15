// The drain state machine behind the dev supervisor's SIGUSR2 handoff, extracted
// from daemon/index.ts so the exit condition is unit-testable. Once draining,
// exit the moment no runs are held — so a code edit never interrupts an
// in-flight turn.

const DEFAULT_TICK_MS = 200

export type DrainDeps = {
  // Runs still held (runManager.size()); the drain waits for zero.
  runsHeld: () => number
  exit: () => void
  tickMs?: number
}

export type Drain = {
  // SIGUSR2: start draining (idempotent). Polls the exit condition until it fires.
  begin: () => void
  draining: () => boolean
  // The direct nudge (runManager onEmpty) so the exit doesn't wait on a tick.
  check: () => void
}

export function createDrain(deps: DrainDeps): Drain {
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS
  let draining = false
  let exited = false

  function check(): void {
    if (exited || !draining || deps.runsHeld() > 0) return
    exited = true // stop the tick loop; in production exit() never returns
    deps.exit()
  }

  function begin(): void {
    if (draining) return
    draining = true
    const tick = () => {
      check()
      if (exited) return
      const t = setTimeout(tick, tickMs)
      t.unref?.()
    }
    tick()
  }

  return { begin, draining: () => draining, check }
}
