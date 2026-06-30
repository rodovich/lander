// Drain-handoff supervisor for the host daemon — replaces `tsx watch
// daemon/index.ts` in dev.mjs. On a daemon source change we must NOT kill the
// running daemon: it owns the claude children for every riding task, so a hard
// restart aborts each in-flight turn (the old "decision 2" behavior). Instead we
// signal the running daemon to *drain* (SIGUSR1 — finish its turns, take no new
// ones, exit when empty) and spawn a fresh daemon. The server adopts the newcomer
// as primary and routes all future turns to it, while the draining one finishes
// what it's riding. So a daemon edit takes effect at turn boundaries with no
// interruption. A max-drain timer SIGTERMs a daemon that never finishes, bounding
// the worst case to today's hard-restart behavior.
//
// Runs the daemon with plain `tsx` (no --watch); this file owns the watching.

import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
// How long to let a draining daemon finish before forcing it down. Past this a
// riding turn is presumed stuck; SIGTERM falls back to the daemon's hard-kill.
const MAX_DRAIN_MS = Number(process.env.LANDER_MAX_DRAIN_MS ?? 15 * 60_000)

let current = null
const draining = new Set()

function spawnDaemon() {
  const child = spawn('tsx', [ENTRY], { cwd: ROOT, stdio: 'inherit', env: process.env })
  child.on('exit', () => {
    draining.delete(child)
    if (current === child) current = null
  })
  current = child
}

function reload() {
  const old = current
  if (old) {
    // Hand off: tell the old daemon to drain, and stop tracking it as current so
    // the next edit doesn't re-signal it. It exits itself once its runs finish.
    draining.add(old)
    try {
      old.kill('SIGUSR1')
    } catch {}
    const force = setTimeout(() => {
      try {
        old.kill('SIGTERM')
      } catch {}
    }, MAX_DRAIN_MS)
    force.unref()
    old.on('exit', () => clearTimeout(force))
  }
  spawnDaemon()
}

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
      debounce = setTimeout(reload, 200)
    })
  } catch {
    // a missing dir just isn't watched
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const child of [current, ...draining]) {
      try {
        child?.kill('SIGTERM')
      } catch {}
    }
    process.exit(0)
  })
}

spawnDaemon()
