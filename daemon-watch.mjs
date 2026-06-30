// Drain-handoff supervisor for the host daemon — replaces `tsx watch
// daemon/index.ts` in dev.mjs. On a daemon source change we must NOT kill the
// running daemon: it owns the claude children for every riding task, so a hard
// restart aborts each in-flight turn (the old "decision 2" behavior). Instead we
// signal the running daemon to *drain* (SIGUSR1 — finish its turns, take no new
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
// The daemon's import graph we reload on — the entry plus the server modules it
// imports (mirrors what `tsx watch` tracked transitively). Editing other server
// files reloads the server (tsx watch server/index.ts), not the daemon.
const WATCHED = [
  ENTRY,
  'server/stream.ts',
  'server/projects.ts',
  'server/usage.ts',
  'server/protocol.ts',
]

const sup = createSupervisor({
  spawn: () => spawn('tsx', [ENTRY], { cwd: ROOT, stdio: 'inherit', env: process.env }),
  // How long to let a draining daemon finish before forcing it down. Past this a
  // riding turn is presumed stuck; SIGTERM falls back to the daemon's hard-kill.
  maxDrainMs: Number(process.env.LANDER_MAX_DRAIN_MS ?? 15 * 60_000),
  log: (m) => console.error(m),
})

// Watch parent dirs (robust to editors that replace a file's inode on save) and
// filter to the watched basenames. Debounced so a burst of writes triggers one
// handoff.
const byDir = new Map()
for (const rel of WATCHED) {
  const abs = path.join(ROOT, rel)
  const dir = path.dirname(abs)
  if (!byDir.has(dir)) byDir.set(dir, new Set())
  byDir.get(dir).add(path.basename(abs))
}
let debounce = null
for (const [dir, bases] of byDir) {
  try {
    watch(dir, (_event, filename) => {
      if (!filename || !bases.has(path.basename(filename))) return
      clearTimeout(debounce)
      debounce = setTimeout(() => sup.reload(), 200)
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
