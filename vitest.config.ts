import { defineConfig } from 'vitest/config'

// Unit tests run in Node by default — most of the logic under test (the stream
// reducer, task store, path/status helpers) is plain server-side TypeScript.
// JSX/TSX (the markdown renderer) is transformed by esbuild via tsconfig's
// `jsx: react-jsx`, and exercised through react-dom/server, so no DOM env is
// needed. Tests live next to the code they cover as `*.test.ts(x)`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['{server,src,bin}/**/*.test.{ts,tsx}'],
    // Keep `npm test` green at the bootstrap commit, before any suites exist.
    passWithNoTests: true,
  },
})
