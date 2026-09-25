// A macOS power assertion, held while the daemon is riding a run. Without it an
// idle Mac sleeps mid-turn, and because the loop clock counts time spent asleep,
// the idle watchdog (daemon/run.ts) expires the moment the machine wakes and
// kills a run that never idled at all.
//
// This shrinks the window where that can happen; it does not close it. No
// assertion survives a closed lid or an explicit Sleep, so the watchdog still
// needs to tolerate a suspension it couldn't prevent.

import { spawn as spawnProcess } from 'node:child_process'

const CAFFEINATE = '/usr/bin/caffeinate'

// Only the handle bits we use, so a test can stand in for a ChildProcess.
export type WakeChild = {
  kill: () => void
  unref?: () => void
  on?: (event: 'error' | 'exit', listener: () => void) => void
}

export type WakeHoldDeps = {
  spawn?: (command: string, args: string[]) => WakeChild
  platform?: string
  // The pid `caffeinate -w` watches. Defaults to ours.
  pid?: number
}

export type WakeHold = {
  // Idempotent: a second hold while one is live is a no-op, so this can be
  // called on every start-run without counting.
  hold: () => void
  release: () => void
  held: () => boolean
}

export function createWakeHold(deps: WakeHoldDeps = {}): WakeHold {
  const platform = deps.platform ?? process.platform
  const pid = deps.pid ?? process.pid
  const spawn =
    deps.spawn ??
    ((command: string, args: string[]) =>
      spawnProcess(command, args, { stdio: 'ignore' }))

  let child: WakeChild | undefined

  function hold(): void {
    if (platform !== 'darwin' || child) return
    let started: WakeChild
    try {
      // -s asserts against system sleep, which macOS honors *only on AC power*.
      // That is the policy we want — never pin a laptop awake off the charger —
      // and it comes for free, with no battery state to poll or keep current.
      //
      // -w exits the assertion when this daemon does. Belt and braces against
      // the failure that would matter most: a SIGKILLed or crashed daemon
      // leaving an orphan that keeps the Mac awake indefinitely, with no run to
      // justify it and nothing left that knows to kill it. daemon-watch replaces
      // this process on every `daemon/**` edit, so that path is well travelled.
      started = spawn(CAFFEINATE, ['-s', '-w', String(pid)])
    } catch {
      // Best-effort: a Mac without caffeinate just keeps today's behavior.
      return
    }
    child = started
    // Forget a handle that dies on its own (spawn failure surfaces async as
    // 'error'), so the next hold() spawns a real one instead of trusting an
    // assertion we no longer have.
    const forget = (): void => {
      if (child === started) child = undefined
    }
    started.on?.('error', forget)
    started.on?.('exit', forget)
    // The assertion must never be the reason the daemon's loop stays alive.
    started.unref?.()
  }

  function release(): void {
    child?.kill()
    child = undefined
  }

  return { hold, release, held: () => child !== undefined }
}
