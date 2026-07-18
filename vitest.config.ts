import { defineConfig } from 'vitest/config'

// Unit tests run in Node by default — most of the logic under test (the stream
// reducer, task store, path/status helpers) is plain server-side TypeScript.
// JSX/TSX (the markdown renderer) is transformed by esbuild via tsconfig's
// `jsx: react-jsx`, and exercised through react-dom/server, so no DOM env is
// needed. Tests live next to the code they cover as `*.test.ts(x)`.
export default defineConfig({
  test: {
    environment: 'node',
    // Server/UI suites live next to their code; the root-level *.test.ts covers
    // the dev tooling (e.g. the daemon supervisor in daemon-supervisor.mjs).
    include: ['{server,src,bin,daemon,flow}/**/*.test.{ts,tsx}', '*.test.{ts,tsx}'],
    // Keep `npm test` green at the bootstrap commit, before any suites exist.
    passWithNoTests: true,
  },
})
