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

// Env with every lander identity var cleared, so the parsing/pre-network guards
// fire deterministically rather than hitting a stray ambient value.
function bareEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.LANDER_API
  delete env.LANDER_TASK
  delete env.LANDER_PROJECT
  delete env.LANDER_TOKEN
  return env
}

describe('lander ask', () => {
  it('rejects a malformed --option (shares wedge parsing)', async () => {
    const { stderr, code } = await execLander(['ask', '--option', 'id:'], bareEnv())
    expect(code).not.toBe(0)
    expect(stderr).toContain('--option must be <id:label>')
  })

  it('requires at least one --option (choice-only; no free-text ask)', async () => {
    const { stderr, code } = await execLander(['ask'], bareEnv())
    expect(code).not.toBe(0)
    expect(stderr).toContain('needs at least one --option')
  })

  it('a well-formed choice ask reaches the network guard once parsed', async () => {
    const { stderr, code } = await execLander(
      ['ask', '--option', 'a:Alpha', '--option', 'b:Beta'],
      bareEnv(),
    )
    expect(code).not.toBe(0)
    // Options parsed fine → it tried to raise the ask and hit the missing task.
    expect(stderr).toContain('no current task')
  })
})
