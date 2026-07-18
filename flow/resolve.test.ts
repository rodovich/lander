// The `lander/flow` specifier resolves through this package's `exports`
// self-reference rather than a bundler alias, so it has to work under every
// runtime that loads flow code. vitest is covered implicitly (the other suites
// import it); this pins the one that has no other coverage and matters most —
// `node --import tsx`, exactly how daemon-watch.mjs spawns the daemon and how
// run.ts spawns the flow host. A resolution break here would surface as a dead
// daemon in the running stack, not a failing unit test.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('lander/flow resolution', () => {
  it('resolves under `node --import tsx` (the daemon + flow-host runtime)', () => {
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        "import { gitContext } from 'lander/flow'; " +
          "console.log('resolved:', typeof gitContext)",
      ],
      { encoding: 'utf8', cwd: ROOT },
    )
    expect(r.stdout + r.stderr).toContain('resolved: function')
  })
})
