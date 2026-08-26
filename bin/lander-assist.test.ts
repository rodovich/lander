import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assistArgv } from '../daemon/assist'

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const LANDER_BIN = path.join(BIN_DIR, 'lander')

type Harness = {
  dir: string
  log: string
  env: NodeJS.ProcessEnv
  cleanup: () => Promise<void>
}

async function makeHarness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lander-assist-'))
  const log = path.join(dir, 'calls.jsonl')
  await writeFakeAgent(dir, 'claude')
  await writeFakeAgent(dir, 'codex')
  // Every variable this suite is about is REMOVED from the inherited
  // environment, so each test states what it is testing rather than inheriting
  // it. These tests run inside a lander task, whose turn now carries
  // LANDER_ASSIST_PROVIDER — so a base of `process.env` made the fallback case
  // pass or fail depending on which provider happened to be running it.
  const { LANDER_ASSIST_PROVIDER: _p, LANDER_AGENT: _a, ...rest } = process.env
  return {
    dir,
    log,
    env: {
      ...rest,
      PATH: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
      CALL_LOG: log,
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

async function writeFakeAgent(dir: string, command: 'claude' | 'codex') {
  const file = path.join(dir, command)
  await writeFile(
    file,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'

appendFileSync(
  process.env.CALL_LOG,
  JSON.stringify({
    command: ${JSON.stringify(command)},
    args: process.argv.slice(2),
  }) + '\\n',
)
process.stdout.write(${JSON.stringify(`${command} reply\n`)})
`,
  )
  await chmod(file, 0o755)
}

function execLander(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [LANDER_BIN, ...args],
      {
        env,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 5_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr })
          reject(error)
          return
        }
        resolve({ stdout, stderr })
      },
    )
  })
}

async function readCalls(log: string) {
  const raw = await readFile(log, 'utf8')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

// The argv `bin/lander` builds is a copy of daemon/assist.ts's, because bin/ is
// plain JS outside tsconfig's include and cannot import it. These tests are what
// keeps the copy honest: every one compares the CLI's OBSERVED argv against
// `assistArgv`'s answer for the same provider, prompt and environment. A change
// to the clamp on one side and not the other fails here rather than shipping a
// judge that can write to the target's checkout.
const PROMPT = 'summarize:\nnotes'

describe('lander assist', () => {
  it('runs a clamped claude one-shot, with the argv daemon/assist.ts builds', async () => {
    const h = await makeHarness()
    try {
      const { stdout } = await execLander(['assist', 'summarize:', 'notes'], h.env)

      expect(stdout).toBe('claude reply\n')
      expect(await readCalls(h.log)).toEqual([
        { command: 'claude', args: assistArgv('claude', PROMPT, {}).args },
      ])
      // Stated here too, so a reader sees what the shared function returns
      // rather than only that the two agree.
      expect(assistArgv('claude', PROMPT, {}).args).toEqual([
        '--disallowedTools',
        'Bash',
        'Edit',
        'Write',
        'NotebookEdit',
        '-p',
        '--',
        PROMPT,
      ])
    } finally {
      await h.cleanup()
    }
  })

  it('takes the provider from the task, not from the instance default', async () => {
    const h = await makeHarness()
    try {
      // LANDER_AGENT says claude — it is the server's default for NEW tasks and
      // reaches every shell. The task's own provider must win.
      const { stdout } = await execLander(['assist', 'summarize:', 'notes'], {
        ...h.env,
        LANDER_AGENT: 'claude',
        LANDER_ASSIST_PROVIDER: ' CODEX ',
      })

      expect(stdout).toBe('codex reply\n')
      expect(await readCalls(h.log)).toEqual([
        { command: 'codex', args: assistArgv('codex', PROMPT, {}).args },
      ])
    } finally {
      await h.cleanup()
    }
  })

  it('carries the deployment’s codex profile and config overrides', async () => {
    const h = await makeHarness()
    const env = {
      LANDER_CODEX_PROFILE: 'lander',
      LANDER_CODEX_CONFIG: 'model="o4"\n\nsandbox_workspace_write.network_access=false',
    }
    try {
      await execLander(['assist', 'summarize:', 'notes'], {
        ...h.env,
        ...env,
        LANDER_ASSIST_PROVIDER: 'codex',
      })

      const argv = assistArgv('codex', PROMPT, env).args
      expect(await readCalls(h.log)).toEqual([{ command: 'codex', args: argv }])
      // The clamp precedes the profile, so a profile asking for
      // workspace-write cannot widen the judge back out.
      expect(argv.indexOf('--sandbox')).toBeLessThan(argv.indexOf('--profile'))
    } finally {
      await h.cleanup()
    }
  })

  it('falls back to the instance default outside a task turn', async () => {
    const h = await makeHarness()
    try {
      // No LANDER_ASSIST_PROVIDER: either this call is not inside a turn, or the
      // turn predates the variable. Either way the old behavior, not an error —
      // the CLI cannot tell those apart from an announced flow.
      const { stdout } = await execLander(['assist', 'summarize:', 'notes'], {
        ...h.env,
        LANDER_AGENT: 'codex',
      })

      expect(stdout).toBe('codex reply\n')
      expect(await readCalls(h.log)).toEqual([
        { command: 'codex', args: assistArgv('codex', PROMPT, {}).args },
      ])
    } finally {
      await h.cleanup()
    }
  })

  it('falls back to claude for an unsupported provider value', async () => {
    const h = await makeHarness()
    try {
      const { stdout } = await execLander(['assist', 'summarize:', 'notes'], {
        ...h.env,
        LANDER_ASSIST_PROVIDER: 'other',
      })

      expect(stdout).toBe('claude reply\n')
      expect(await readCalls(h.log)).toEqual([
        { command: 'claude', args: assistArgv('claude', PROMPT, {}).args },
      ])
    } finally {
      await h.cleanup()
    }
  })
})
