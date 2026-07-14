// The drain state machine behind the dev supervisor's SIGUSR1 handoff, extracted
// from daemon/index.ts so the exit condition is unit-testable. Once draining,
// exit the moment no runs are held AND no settle-sweep is in flight — a sweep
// that observed a stray but hasn't written its registry entry must finish
// (registry durability covers unacked wakes, not unwritten adoptions) — but a
// sweep stuck on an unanswerable gate is abandoned past a bounded grace rather
// than holding the drain open; the successor's nudge-walk re-covers live strays.
// Job-watch timers stop the moment the drain begins: watching transfers to the
// survivor via the server's rescan nudge on our exit.

export const DRAIN_SWEEP_GRACE_MS = 5_000
const DEFAULT_TICK_MS = 200

export type DrainDeps = {
  // Runs still held (runManager.size()); the drain waits for zero.
  runsHeld: () => number
  // Whether a settle-sweep is mid-flight (jobs.sweepInFlight()).
  sweepInFlight: () => boolean
  // Stop the job-watch timers (jobs.stopTimers) — called once, at begin.
  stopTimers: () => void
  exit: () => void
  graceMs?: number
  tickMs?: number
  now?: () => number
}

export type Drain = {
  // SIGUSR1: start draining (idempotent — the grace isn't re-armed). Stops the
  // watch timers and polls the exit condition until it fires.
  begin: () => void
  draining: () => boolean
  // The direct nudge (runManager onEmpty) so the exit doesn't wait on a tick.
  check: () => void
}

export function createDrain(deps: DrainDeps): Drain {
  const graceMs = deps.graceMs ?? DRAIN_SWEEP_GRACE_MS
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS
  const now = deps.now ?? Date.now
  let draining = false
  let deadline = Infinity
  let exited = false

  function check(): void {
    if (exited || !draining || deps.runsHeld() > 0) return
    if (deps.sweepInFlight() && now() < deadline) return
    exited = true // stop the tick loop; in production exit() never returns
    deps.exit()
  }

  function begin(): void {
    if (draining) return
    draining = true
    deadline = now() + graceMs
    deps.stopTimers()
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
