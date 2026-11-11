import { defineConfig } from 'vitest/config'

// Browser tests drive the installed Google Chrome through playwright-core, so
// they are kept out of `npm test`: run them with
// `npm test -- --config vitest.browser.config.ts`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['browser/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
