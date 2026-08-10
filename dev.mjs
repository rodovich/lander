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
// Each of the three below goes to the ONE process that needs it, via
// concurrently's per-command env, rather than onto this process's env where all
// three children would inherit it. That inheritance is how the UI token used to
// reach every task's shell: it flows on into the daemon's flow host and the
// agent child, and a task presenting it as x-lander-ui-token resolves as the
// trusted human on every route.
//
// The delete is load-bearing, not tidiness: per-command env merges OVER
// process.env and can only add, so an ambient value exported in the developer's
// shell would otherwise reach all three commands and reinstate the leak.
//
// Duplicated from SCRUBBED_ENV_KEYS in server/secrets.ts — keep in sync. This
// file runs under plain node, so it cannot import the TypeScript module.
for (const key of [
  'LANDER_UI_TOKEN',
  'VITE_LANDER_UI_TOKEN',
  'LANDER_DAEMON_TOKEN',
]) {
  delete process.env[key]
}
// The daemon authenticates its WS upgrade with LANDER_DAEMON_TOKEN and the
// server accepts it. Same host/user, so the two share the one secret; splitting
// them is worth doing alongside moving it out of a served project directory,
// which is what would make either value hard for a task to obtain.
const webEnv = { VITE_LANDER_UI_TOKEN: uiToken }
const apiEnv = { LANDER_UI_TOKEN: uiToken, LANDER_DAEMON_TOKEN: uiToken }
const daemonEnv = { LANDER_DAEMON_TOKEN: uiToken }

// Fail loudly here rather than three silent failures downstream. Nothing
// typechecks or tests this file, and each map fails differently and quietly if
// it comes out empty: the browser omits the header entirely when its token is
// undefined (src/api.ts), so every UI-only action 403s with nothing to point at;
// the api falls back to reading data/.ui-token, hiding the problem further; the
// daemon reconnect-loops.
for (const [name, env] of [
  ['web', webEnv],
  ['api', apiEnv],
  ['daemon', daemonEnv],
]) {
  for (const [key, value] of Object.entries(env)) {
    if (!value) {
      console.error(`dev.mjs: ${name} would start with an empty ${key}`)
      process.exit(1)
    }
  }
}

// The daemon dials the server's /daemon endpoint; keep it in sync with PORT.
process.env.LANDER_WS = `ws://localhost:${process.env.PORT ?? 6181}/daemon`

concurrently(
  [
    { command: 'vite', name: 'web', prefixColor: 'blue', env: webEnv },
    // `watch` reloads the API on server edits. This is safe because runs live in
    // the daemon (a separate process that outlives the server): an in-flight run
    // keeps going across a reload, the fresh server reattaches over the WS and
    // resumes it from the persisted cursor (resume-from; see recoverQueues), and
    // the server drains open requests before exiting (graceful shutdown in
    // server/index.ts). So a restart — including when claude edits
    // server/index.ts while lander runs on its own repo — no longer loses a run.
    {
      command: 'tsx watch server/index.ts',
      name: 'api',
      prefixColor: 'green',
      env: apiEnv,
    },
    // The host daemon owns claude process management + stream reduction + usage.
    // It reads PROJECT_DIRS from the env above. daemon-watch.mjs supervises it: on
    // a daemon source edit it drains the running daemon (finish riding turns, take
    // no new ones, exit when empty) and hands off to a fresh one, so an edit no
    // longer aborts in-flight turns — it takes effect at the next turn boundary.
    {
      command: 'node daemon-watch.mjs',
      name: 'daemon',
      prefixColor: 'magenta',
      env: daemonEnv,
    },
  ],
  { killOthers: ['failure', 'success'] },
).result.catch(() => process.exit(1))
