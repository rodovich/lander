// The host daemon's lifecycle decisions, factored out of daemon-watch.mjs so they
// can be unit-tested with an injected spawner (no real `tsx` processes). It owns
// which daemon is `current`, handing off to a replacement on reload, and — the
// part worth testing — respawning the live daemon when it exits unexpectedly
// (with crash-loop backoff), while never respawning a drained predecessor or
// during shutdown.
//
// `spawn()` returns a child-process-like object: an EventEmitter that emits
// 'exit' (code, signal) and 'message' (the daemon's IPC messages), and has a
// `.kill(signal)` method. The clock/timer hooks default to the globals; the test
// injects deterministic ones.

export function createSupervisor({
  spawn,
  maxDrainMs = 12 * 60 * 60_000,
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
  // The replacement a reload() spawned, until it registers with the server. The
  // current daemon keeps serving until then, so a replacement that can't boot (an
  // edit that doesn't parse) leaves the stack on the last working daemon rather
  // than on none.
  let pending = null
  const draining = new Set()
  let shuttingDown = false
  let crashes = 0

  const sendSignal = (child, sig) => {
    try {
      child?.kill(sig)
    } catch {}
  }
  const describeExit = (code, signal) => `code ${code}, signal ${signal ?? 'none'}`

  function spawnChild() {
    const startedAt = now()
    const child = spawn()
    child.on('message', (msg) => {
      // daemon/index.ts relays the server's acknowledgement of its register.
      if (msg?.type === 'registered' && child === pending) promote(child)
    })
    child.on('exit', (code, signal) => {
      // A drained predecessor finishing is expected — its replacement is already
      // current — so let it go without respawning.
      if (draining.delete(child)) return
      if (child === pending) {
        pending = null
        if (!shuttingDown)
          log(
            `replacement daemon exited before registering (${describeExit(code, signal)}); ` +
              `the previous daemon keeps serving. Fix the error logged above; ` +
              `the next daemon edit retries the handoff.`,
          )
        return
      }
      if (current !== child) return // stale, already superseded
      current = null
      if (shuttingDown) return
      if (pending) {
        log(`daemon exited (${describeExit(code, signal)}); its pending replacement takes over`)
        current = pending
        pending = null
        return
      }
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
            `${crashes} times in a row (${describeExit(code, signal)}); ` +
            `the stack is running with NO daemon and tasks cannot start until it ` +
            `boots. Fix the boot error logged above; retrying in ${delay}ms.`,
        )
      else
        log(
          `daemon exited (${describeExit(code, signal)}); ` +
            `respawning${delay ? ` in ${delay}ms` : ''}`,
        )
      // Guard on `current === null`: a reload() may have spawned a fresh daemon in
      // the backoff window, in which case we must not spawn a second.
      const timer = setTimer(() => {
        if (!shuttingDown && current === null) spawnDaemon()
      }, delay)
      timer?.unref?.()
    })
    return child
  }

  function spawnDaemon() {
    current = spawnChild()
    return current
  }

  // The server has registered the pending replacement and routes new runs to it,
  // so its predecessor can drain.
  function promote(child) {
    const old = current
    pending = null
    current = child
    drain(old)
  }

  function drain(child) {
    draining.add(child)
    // SIGUSR2, not SIGUSR1: Node reserves SIGUSR1 for the inspector, so a drain
    // signal must use the one conventionally-free user signal.
    sendSignal(child, 'SIGUSR2')
    const force = setTimer(() => sendSignal(child, 'SIGTERM'), maxDrainMs)
    force?.unref?.()
    child.on('exit', () => clearTimer(force))
  }

  function reload() {
    // A deliberate reload (a source edit) is a fresh start, not part of any crash
    // loop — clear the crash-backoff state so applying a fix recovers immediately
    // and cleanly, rather than inheriting the escalated backoff/warning left by the
    // boot errors that preceded it.
    crashes = 0
    // With no daemon serving there is nothing to keep up during a handoff.
    if (!current) return spawnDaemon()
    // A replacement from an earlier edit that hasn't reported registering runs
    // code this edit supersedes. It may still have been handed a run in the
    // moment before its report arrived, so drain it rather than kill it.
    if (pending) drain(pending)
    pending = spawnChild()
    return pending
  }

  function shutdown() {
    shuttingDown = true
    for (const child of [current, pending, ...draining]) sendSignal(child, 'SIGTERM')
  }

  return {
    spawnDaemon,
    reload,
    shutdown,
    get current() {
      return current
    },
    get pending() {
      return pending
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
