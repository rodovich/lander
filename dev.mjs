import { concurrently } from 'concurrently'
import path from 'node:path'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: npm run dev /path/to/project')
  process.exit(1)
}

const PROJECT_DIR = path.resolve(arg)
console.log(`project: ${PROJECT_DIR}`)

// Inherited by both child processes; only the api server reads it.
process.env.PROJECT_DIR = PROJECT_DIR

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
