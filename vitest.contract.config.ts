import { defineConfig } from 'vitest/config'

// Contract tests run lander's integrations against the real `claude` and `codex`
// CLIs, to catch the CLI changing under us (see contract/README.md). They spend
// real tokens and need both CLIs installed and signed in, so they are kept out of
// `npm test` and run with `npm run test:contract`. One file and one test at a
// time: each makes live model calls, and parallel runs would only add rate-limit
// noise.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['contract/**/*.contract.ts'],
    setupFiles: ['contract/setup.ts'],
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
})
