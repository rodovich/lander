// The host daemon's lifecycle decisions, factored out of daemon-watch.mjs so they
// can be unit-tested with an injected spawner (no real `tsx` processes). It owns
// which daemon is `current`, draining a predecessor on reload, and — the part
// worth testing — respawning the live daemon when it exits unexpectedly (with
// crash-loop backoff), while never respawning a drained predecessor or during
// shutdown.
//
// `spawn()` returns a child-process-like object: an EventEmitter that emits
// 'exit' (code, signal) and has a `.kill(signal)` method. The clock/timer hooks
// default to the globals; the test injects deterministic ones.

export function createSupervisor({
  spawn,
  maxDrainMs = 15 * 60_000,
  crashWindowMs = 3_000,
  respawnBackoffMs = 1_000,
  respawnBackoffMaxMs = 10_000,
  // After this many consecutive fast crashes, stop logging plain "respawning"
  // lines and escalate: the daemon can't boot, so the stack is running daemon-less
  // and no task can start. Web/api keep running, so without a distinct signal this
  // failure is invisible.
  crashLoopThreshold = 3,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
}) {
  let current = null
  const draining = new Set()
  let shuttingDown = false
  let crashes = 0

  function spawnDaemon() {
    const startedAt = now()
    const child = spawn()
    child.on('exit', (code, signal) => {
      // A drained predecessor finishing is expected — its replacement was spawned
      // when we began draining it, so let it go without respawning.
      if (draining.delete(child)) return
      if (current !== child) return // stale, already superseded
      current = null
      if (shuttingDown) return
      // The live daemon exited on its own (crash, idle-kill, an external kill).
      // Bring one back so the stack never sits daemon-less. Back off if it's
      // exiting right after startup, so a daemon that can't boot doesn't spin.
      crashes = now() - startedAt < crashWindowMs ? crashes + 1 : 0
      const delay = Math.min(crashes * respawnBackoffMs, respawnBackoffMaxMs)
      if (crashes >= crashLoopThreshold)
        // Escalated: repeated fast exits mean the daemon can't boot at all, not a
        // one-off crash. Say the stack is degraded — tasks can't start — so this
        // isn't lost among identical respawn lines behind a still-running web/api.
        log(
          `daemon CRASH LOOP: exited within ${crashWindowMs}ms of startup ` +
            `${crashes} times in a row (code ${code}, signal ${signal ?? 'none'}); ` +
            `the stack is running with NO daemon and tasks cannot start until it ` +
            `boots. Fix the boot error logged above; retrying in ${delay}ms.`,
        )
      else
        log(
          `daemon exited (code ${code}, signal ${signal ?? 'none'}); ` +
            `respawning${delay ? ` in ${delay}ms` : ''}`,
        )
      // Guard on `current === null`: a reload() may have spawned a fresh daemon in
      // the backoff window, in which case we must not spawn a second.
      const timer = setTimer(() => {
        if (!shuttingDown && current === null) spawnDaemon()
      }, delay)
      timer?.unref?.()
    })
    current = child
    return child
  }

  function reload() {
    const old = current
    if (old) {
      // Hand off: drain the old daemon (it exits once its runs finish) and spawn a
      // fresh one. A max-drain timer forces the old one down if it never finishes.
      draining.add(old)
      try {
        old.kill('SIGUSR1')
      } catch {}
      const force = setTimer(() => {
        try {
          old.kill('SIGTERM')
        } catch {}
      }, maxDrainMs)
      force?.unref?.()
      old.on('exit', () => clearTimer(force))
    }
    return spawnDaemon()
  }

  function shutdown() {
    shuttingDown = true
    for (const child of [current, ...draining]) {
      try {
        child?.kill('SIGTERM')
      } catch {}
    }
  }

  return {
    spawnDaemon,
    reload,
    shutdown,
    get current() {
      return current
    },
    get draining() {
      return draining
    },
    get crashes() {
      return crashes
    },
    get shuttingDown() {
      return shuttingDown
    },
  }
}
