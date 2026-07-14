// Drain-handoff supervisor for the host daemon — replaces `tsx watch
// daemon/index.ts` in dev.mjs. On a daemon source change we must NOT kill the
// running daemon: it owns the claude children for every riding task, so a hard
// restart aborts each in-flight turn (the old "decision 2" behavior). Instead we
// signal the running daemon to *drain* (SIGUSR2 — finish its turns, take no new
// ones, exit when empty) and spawn a fresh daemon. The server adopts the newcomer
// as primary and routes all future turns to it, while the draining one finishes
// what it's riding. So a daemon edit takes effect at turn boundaries with no
// interruption. A max-drain timer SIGTERMs a daemon that never finishes, bounding
// the worst case to today's hard-restart behavior. And if the live daemon exits
// on its own (crash, idle-kill, an external kill), we respawn it — the stack must
// never sit daemon-less, or tasks fail to start with "no daemon connected".
//
// The lifecycle decisions live in daemon-supervisor.mjs (unit-tested); this file
// wires them to the real `tsx` spawner, the fs watcher, and process signals. Runs
// the daemon with plain `tsx` (no --watch); this file owns the watching.

import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSupervisor } from './daemon-supervisor.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = 'daemon/index.ts'
// The daemon reloads on any change to its own code — the whole daemon/ tree — plus
// the server modules it imports. Watching daemon/ wholesale (rather than a hand-
// maintained file list) is deliberate: the old list named only daemon/index.ts and
// a few server files, so the daemon-local modules it imports (agent/claude/codex/
// run) went unwatched. Editing one — including to FIX a boot-time parse/import
// error — didn't trigger a reload, so the supervisor sat in its crash-backoff
// re-running the stale code instead of picking the fix up at once. Everything under
// daemon/ is a daemon dependency by construction, so this can't miss one again.
const DAEMON_DIR = 'daemon'
// Server modules imported by daemon/index.ts (keep in sync with its ../server/*
// imports). Editing these also restarts the api via `tsx watch server/index.ts`;
// here they additionally hand the daemon off, since it imports them too.
const WATCHED_SERVER_FILES = [
  'server/stream.ts',
  'server/projects.ts',
  'server/usage.ts',
  'server/protocol.ts',
]

// A daemon-source change is any non-test .ts file under daemon/.
const isDaemonSource = (name) => name.endsWith('.ts') && !name.endsWith('.test.ts')

const sup = createSupervisor({
  // Spawn the daemon as a DIRECT node child (`node --import tsx`), not via the
  // `tsx` bin. The bin is a wrapper process that relays only SIGINT/SIGTERM to
  // the real daemon underneath, so the supervisor's drain signal sent to the
  // wrapper pid never reached the daemon — graceful drain silently never worked;
  // every superseded daemon sat as a non-draining zombie until max-drain's
  // SIGTERM. Direct spawn means kill() hits the daemon itself.
  spawn: () =>
    spawn(process.execPath, ['--import', 'tsx', ENTRY], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    }),
  // How long to let a draining daemon finish before forcing it down. A last
  // resort, not a routine bound: the run-level idle watchdog (10m of silence)
  // already ends hung runs, so a daemon still draining here is either serving a
  // genuinely active long ride — which must not be killed — or stuck in a way
  // the watchdog failed to catch. Sized accordingly; SIGTERM falls back to the
  // daemon's hard-kill.
  maxDrainMs: Number(process.env.LANDER_MAX_DRAIN_MS ?? 12 * 60 * 60_000),
  log: (m) => console.error(m),
})

// Debounced so a burst of writes (or a recursive-watch fan-out) triggers one
// handoff.
let debounce = null
const scheduleReload = () => {
  clearTimeout(debounce)
  debounce = setTimeout(() => sup.reload(), 200)
}

// Watch the daemon's own directory wholesale (recursive, so a future subdir is
// covered too). Any non-test .ts edit here — index or an imported adapter —
// reloads the daemon.
try {
  watch(path.join(ROOT, DAEMON_DIR), { recursive: true }, (_event, filename) => {
    if (filename && isDaemonSource(path.basename(filename))) scheduleReload()
  })
} catch {
  // a missing dir just isn't watched
}

// Watch the specific server files the daemon imports, by parent dir + basename
// (robust to editors that replace a file's inode on save).
const serverByDir = new Map()
for (const rel of WATCHED_SERVER_FILES) {
  const abs = path.join(ROOT, rel)
  const dir = path.dirname(abs)
  if (!serverByDir.has(dir)) serverByDir.set(dir, new Set())
  serverByDir.get(dir).add(path.basename(abs))
}
for (const [dir, bases] of serverByDir) {
  try {
    watch(dir, (_event, filename) => {
      if (filename && bases.has(path.basename(filename))) scheduleReload()
    })
  } catch {
    // a missing dir just isn't watched
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    sup.shutdown()
    process.exit(0)
  })
}

sup.spawnDaemon()
