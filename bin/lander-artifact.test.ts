import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const LANDER_BIN = path.join(BIN_DIR, 'lander')

function execLander(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [LANDER_BIN, ...args],
      { env, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5_000 },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          code: error && typeof error.code === 'number' ? error.code : 0,
        })
      },
    )
  })
}

// Env with every lander identity var cleared, so the commands hit their
// pre-network guards deterministically rather than a stray ambient value.
function bareEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.LANDER_API
  delete env.LANDER_TASK
  delete env.LANDER_PROJECT
  delete env.LANDER_TOKEN
  return env
}

describe('lander artifact', () => {
  it('put with no path prints usage', async () => {
    const { stderr, code } = await execLander(['artifact', 'put'], bareEnv())
    expect(code).not.toBe(0)
    expect(stderr).toContain('usage: lander artifact put')
  })

  it('cat with no name prints usage', async () => {
    const { stderr, code } = await execLander(['artifact', 'cat'], bareEnv())
    expect(code).not.toBe(0)
    expect(stderr).toContain('usage: lander artifact cat')
  })

  it('an unknown subcommand prints the artifact usage', async () => {
    const { stderr, code } = await execLander(['artifact', 'bogus'], bareEnv())
    expect(code).not.toBe(0)
    expect(stderr).toContain('usage: lander artifact')
  })

  it('put outside a lander task reports the missing API', async () => {
    const { stderr, code } = await execLander(['artifact', 'put', 'x.txt'], bareEnv())
    expect(code).not.toBe(0)
    expect(stderr).toContain('LANDER_API')
  })
})
