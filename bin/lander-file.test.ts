import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

async function makeFilesDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'lander-files-'))
  await writeFile(path.join(dir, 'id-a'), 'a,b\n1,2\n')
  await writeFile(path.join(dir, 'id-b'), 'hello')
  await writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify([
      { id: 'id-a', name: 'data.csv', mime: 'text/csv', size: 8 },
      { id: 'id-b', name: 'note.txt', mime: 'text/plain', size: 5 },
    ]),
  )
  return dir
}

describe('lander file', () => {
  it('ls lists the manifest with sizes', async () => {
    const dir = await makeFilesDir()
    try {
      const { stdout, code } = await execLander(['file', 'ls'], {
        ...process.env,
        LANDER_FILES_DIR: dir,
      })
      expect(code).toBe(0)
      expect(stdout).toContain('id-a')
      expect(stdout).toContain('data.csv')
      expect(stdout).toContain('8')
      expect(stdout).toContain('note.txt')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cat streams a blob by id', async () => {
    const dir = await makeFilesDir()
    try {
      const { stdout, code } = await execLander(['file', 'cat', 'id-a'], {
        ...process.env,
        LANDER_FILES_DIR: dir,
      })
      expect(code).toBe(0)
      expect(stdout).toBe('a,b\n1,2\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('cat rejects a path-escaping id', async () => {
    const dir = await makeFilesDir()
    try {
      const { stderr, code } = await execLander(['file', 'cat', '../manifest.json'], {
        ...process.env,
        LANDER_FILES_DIR: dir,
      })
      expect(code).not.toBe(0)
      expect(stderr).toContain('invalid attachment id')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('errors when LANDER_FILES_DIR is unset', async () => {
    const env = { ...process.env }
    delete env.LANDER_FILES_DIR
    const { stderr, code } = await execLander(['file', 'ls'], env)
    expect(code).not.toBe(0)
    expect(stderr).toContain('LANDER_FILES_DIR')
  })
})
