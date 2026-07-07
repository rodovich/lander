import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  return {
    dir,
    log,
    env: {
      ...process.env,
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

describe('lander assist', () => {
  it('defaults to claude one-shot execution', async () => {
    const h = await makeHarness()
    try {
      const { stdout } = await execLander(
        ['assist', 'summarize:', 'notes'],
        h.env,
      )

      expect(stdout).toBe('claude reply\n')
      expect(await readCalls(h.log)).toEqual([
        {
          command: 'claude',
          args: ['-p', '--', 'summarize:\nnotes'],
        },
      ])
    } finally {
      await h.cleanup()
    }
  })

  it('uses codex exec when LANDER_AGENT defaults new tasks to codex', async () => {
    const h = await makeHarness()
    try {
      const { stdout } = await execLander(
        ['assist', 'summarize:', 'notes'],
        { ...h.env, LANDER_AGENT: ' CODEX ' },
      )

      expect(stdout).toBe('codex reply\n')
      expect(await readCalls(h.log)).toEqual([
        {
          command: 'codex',
          args: ['exec', 'summarize:\nnotes'],
        },
      ])
    } finally {
      await h.cleanup()
    }
  })

  it('falls back to claude for unsupported LANDER_AGENT values', async () => {
    const h = await makeHarness()
    try {
      const { stdout } = await execLander(
        ['assist', 'summarize:', 'notes'],
        { ...h.env, LANDER_AGENT: 'other' },
      )

      expect(stdout).toBe('claude reply\n')
      expect(await readCalls(h.log)).toEqual([
        {
          command: 'claude',
          args: ['-p', '--', 'summarize:\nnotes'],
        },
      ])
    } finally {
      await h.cleanup()
    }
  })
})
