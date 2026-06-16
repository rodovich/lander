import { concurrently } from 'concurrently'
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

concurrently(
  [
    { command: 'vite', name: 'web', prefixColor: 'blue' },
    // No `watch`: the API drives long-running `claude` subprocesses whose
    // replies are only recorded by an in-memory continuation in runClaude. If
    // tsx restarted the server on a file change — and claude edits files in the
    // target project, including server/index.ts when lander runs on its own
    // repo — every in-flight run would be orphaned, leaving its task stuck in
    // "riding" with no reply. Restart the API manually to pick up server edits.
    { command: 'tsx server/index.ts', name: 'api', prefixColor: 'green' },
  ],
  { killOthers: ['failure', 'success'] },
).result.catch(() => process.exit(1))
