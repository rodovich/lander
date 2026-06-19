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

// Inherited by both child processes; only the api server reads it. Newline-
// separated so it survives a single env var (paths never contain newlines).
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

concurrently(
  [
    { command: 'vite', name: 'web', prefixColor: 'blue' },
    // `watch` reloads the API on server edits. This is safe because each turn
    // runs in a detached `lander run` process that outlives the server: an
    // in-flight run keeps going across a reload, the fresh process reattaches to
    // it (see recoverQueues), and the server drains open requests before exiting
    // (graceful shutdown in server/index.ts). So a restart — including when
    // claude edits server/index.ts while lander runs on its own repo — no longer
    // orphans a run or loses a reply.
    { command: 'tsx watch server/index.ts', name: 'api', prefixColor: 'green' },
  ],
  { killOthers: ['failure', 'success'] },
).result.catch(() => process.exit(1))
