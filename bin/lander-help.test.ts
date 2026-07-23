// `lander help` / `--help` / `-h` must PRINT usage and exit 0 without ever
// calling the server. The bug this guards against: `lander launch --help` used
// to fall through launch's positional parse and POST a new task whose message
// was the literal "--help" — a real sibling agent someone then had to stop by
// hand (see tasks flIyTM25-A, tNseG6Vg8Z, SjTfTWz6UV). So the load-bearing
// assertion is `requests === 0`: help touches nothing.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const LANDER_BIN = path.join(BIN_DIR, 'lander')

let server: Server
let port: number
let requests = 0

function execLander(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [LANDER_BIN, ...args],
      {
        env: {
          ...process.env,
          LANDER_API: `http://127.0.0.1:${port}`,
          LANDER_PROJECT: 'proj',
          LANDER_TASK: 'task-1',
          LANDER_TOKEN: 'tok',
        },
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
      },
      (error, stdout, stderr) =>
        resolve({
          stdout,
          stderr,
          code: error && typeof error.code === 'number' ? error.code : 0,
        }),
    )
  })
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    requests++
    res.writeHead(201, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'new-task' }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  requests = 0
})

describe('lander help', () => {
  it('`launch --help` prints launch usage, spawns nothing', async () => {
    const { stdout, code } = await execLander(['launch', '--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('usage: lander launch <message|->')
    expect(requests).toBe(0)
  })

  it('`launch -h` is equivalent', async () => {
    const { stdout, code } = await execLander(['launch', '-h'])
    expect(code).toBe(0)
    expect(stdout).toContain('usage: lander launch <message|->')
    expect(requests).toBe(0)
  })

  it('bare `--help` prints the full command index', async () => {
    const { stdout, code } = await execLander(['--help'])
    expect(code).toBe(0)
    expect(stdout).toContain('commands:')
    expect(stdout).toContain('lander launch')
    expect(stdout).toContain('lander view')
    expect(requests).toBe(0)
  })

  it('`help <command>` prints that command', async () => {
    const { stdout, code } = await execLander(['help', 'send'])
    expect(code).toBe(0)
    expect(stdout).toContain('usage: lander send <id> <message|->')
    expect(requests).toBe(0)
  })

  it('an unknown command prints the index and exits non-zero', async () => {
    const { stdout, stderr, code } = await execLander(['frobnicate'])
    expect(code).toBe(1)
    expect(stderr).toContain('unknown command: frobnicate')
    expect(stdout).toContain('commands:')
    expect(requests).toBe(0)
  })
})
