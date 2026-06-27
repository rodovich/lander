import { concurrently } from 'concurrently'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('usage: npm run dev /path/to/project [/path/to/another ...]')
  process.exit(1)
}

const projects = args.map((a) => path.resolve(a))
console.log('projects:')
for (const p of projects) console.log(`  ${p}`)

// Inherited by the child processes; the api server and the daemon both read it.
// Newline-separated so it survives a single env var (paths never contain newlines).
process.env.PROJECT_DIRS = projects.join('\n')

// A shared secret that lets the browser prove its requests are the human's, so
// the API can refuse a task trying to grant itself (or a task it spawns) more
// permission than it has. The same value goes to Vite — which inlines it into
// the client as VITE_LANDER_UI_TOKEN — and to the API server as
// LANDER_UI_TOKEN. Persisted under data/ (gitignored) so a manual API restart
// keeps the value the running browser already holds; mode 0600.
const tokenFile = path.resolve('data', '.ui-token')
let uiToken
try {
  uiToken = readFileSync(tokenFile, 'utf8').trim()
} catch {
  // not yet created
}
if (!uiToken) {
  uiToken = randomUUID()
  mkdirSync(path.dirname(tokenFile), { recursive: true })
  writeFileSync(tokenFile, uiToken + '\n', { mode: 0o600 })
}
process.env.LANDER_UI_TOKEN = uiToken
process.env.VITE_LANDER_UI_TOKEN = uiToken
// The daemon authenticates its WS upgrade with this; the server accepts it
// (DAEMON_TOKEN falls back to LANDER_UI_TOKEN, but set it explicitly so both
// sides agree regardless). Same host/user, so they share the one secret.
process.env.LANDER_DAEMON_TOKEN = uiToken
// The daemon dials the server's /daemon endpoint; keep it in sync with PORT.
process.env.LANDER_WS = `ws://localhost:${process.env.PORT ?? 6181}/daemon`

concurrently(
  [
    { command: 'vite', name: 'web', prefixColor: 'blue' },
    // `watch` reloads the API on server edits. This is safe because runs live in
    // the daemon (a separate process that outlives the server): an in-flight run
    // keeps going across a reload, the fresh server reattaches over the WS and
    // resumes it from the persisted cursor (resume-from; see recoverQueues), and
    // the server drains open requests before exiting (graceful shutdown in
    // server/index.ts). So a restart — including when claude edits
    // server/index.ts while lander runs on its own repo — no longer loses a run.
    { command: 'tsx watch server/index.ts', name: 'api', prefixColor: 'green' },
    // The host daemon owns claude process management + stream reduction + usage.
    // It reads PROJECT_DIRS from the env above. `watch` reloads it on daemon
    // edits; a reload aborts any in-flight turn (decision 2), which the server
    // surfaces as a wedge the user can retry.
    { command: 'tsx watch daemon/index.ts', name: 'daemon', prefixColor: 'magenta' },
  ],
  { killOthers: ['failure', 'success'] },
).result.catch(() => process.exit(1))
