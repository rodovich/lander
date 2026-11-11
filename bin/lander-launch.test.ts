// `lander launch --flow <name> [--key k v …]`.
//
// The value coercion is the load-bearing part and it has no other coverage:
// bin/ is outside tsconfig.json's `include`, so `npm run typecheck` — the
// per-commit gate everywhere else — sees none of this file's subject. argv
// values are always strings, so `--key dryRun false` would otherwise hand a
// flow the TRUTHY string "false", which is precisely the bug that would make a
// dry-run default useless.
//
// Driven against a stub HTTP server so the assertions are on the POST body the
// CLI actually sends, not on its argument parsing in isolation.

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
let lastBody: Record<string, unknown> | undefined
let lastUrl: string | undefined

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

const COMPOSED = '/api/proj/tasks/task-1/composed/'
const DRAFTS: Record<string, { message: string; managed?: true }> = {
  hi: { message: 'say hi' },
  go: { message: 'go ahead' },
  probe: { message: 'run the probe', managed: true },
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      res.writeHead(req.method === 'GET' ? 200 : 201, {
        'content-type': 'application/json',
      })
      if (req.method === 'GET' && req.url?.startsWith(COMPOSED)) {
        res.end(JSON.stringify(DRAFTS[req.url.slice(COMPOSED.length)]))
        return
      }
      lastBody = raw ? JSON.parse(raw) : undefined
      lastUrl = req.url
      res.end(JSON.stringify({ id: 'new-task' }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  lastBody = undefined
  lastUrl = undefined
})

describe('lander launch --flow', () => {
  it('posts the requested flow', async () => {
    const { stdout, code } = await execLander([
      'launch',
      '--flow',
      'codex',
      '--composed',
      'hi',
    ])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe('new-task')
    expect(lastBody).toMatchObject({ flow: 'codex', message: 'say hi' })
  })

  it('posts the composed message, not its id', async () => {
    const { code } = await execLander(['launch', '--composed', 'hi'])
    expect(code).toBe(0)
    expect(lastBody?.message).toBe('say hi')
  })

  it('omits flow entirely when none is given', async () => {
    await execLander(['launch', '--composed', 'hi'])
    expect(lastBody).toBeDefined()
    expect('flow' in lastBody!).toBe(false)
  })

  it('coerces --key values to real types, keeping bare strings as strings', async () => {
    await execLander([
      'launch',
      '--flow',
      'example-flow',
      '--key',
      'n',
      '3',
      '--key',
      's',
      'hi',
      '--key',
      'b',
      'false',
      '--key',
      'nil',
      'null',
      '--composed',
      'go',
    ])
    // The whole point: `false` is a boolean, not the truthy string "false",
    // and `main`-style bare words survive as strings rather than failing.
    expect(lastBody?.flowConfig).toEqual({ n: 3, s: 'hi', b: false, nil: null })
  })

  it('keeps a branch-like value a string', async () => {
    await execLander(['launch', '--key', 'branch', 'main', '--composed', 'go'])
    expect(lastBody?.flowConfig).toEqual({ branch: 'main' })
  })

  it('rejects --key without a name', async () => {
    const { stderr, code } = await execLander(['launch', '--key'])
    expect(code).not.toBe(0)
    expect(stderr).toContain('--key needs a name and a value')
  })
})

describe('lander launch --await', () => {
  it('is refused, spawning nothing', async () => {
    const { stderr, code } = await execLander(['launch', '--await', '--composed', 'hi'])
    expect(code).not.toBe(0)
    expect(stderr).toContain('unexpected argument "--await"')
    expect(lastBody).toBeUndefined()
  })
})

describe('lander send --', () => {
  it('sends to the id after a `--`, with options on either side', async () => {
    const { code } = await execLander(['send', '--', '-target', '--composed', 'hi'])
    expect(code).toBe(0)
    expect(lastUrl).toBe('/api/proj/tasks/-target/messages')
    expect(lastBody?.message).toBe('say hi')
  })
})

describe('lander compose --managed', () => {
  it('composes the message as managed and skips the check against the user request', async () => {
    const { stdout, code } = await execLander(['compose', '--managed', 'run the probe'])
    expect(code).toBe(0)
    expect(lastBody).toMatchObject({ message: 'run the probe', managed: true })
    expect(stdout).not.toContain('what the user requested')
  })

  it('composes without managed, and with the check, when the flag is absent', async () => {
    const { stdout } = await execLander(['compose', 'fix the bug'])
    expect(lastBody?.message).toBe('fix the bug')
    expect(lastBody?.managed).not.toBe(true)
    expect(stdout).toContain('what the user requested')
  })

  it('launches a managed draft as managed', async () => {
    await execLander(['launch', '--composed', 'probe'])
    expect(lastBody).toMatchObject({ managed: true, message: 'run the probe' })
  })

  it('launches an unmanaged draft without managed', async () => {
    await execLander(['launch', '--composed', 'hi'])
    expect(lastBody?.managed).not.toBe(true)
  })

  it('refuses to send a managed draft, which skipped the check against the user request', async () => {
    const { stderr, code } = await execLander(['send', 'other-task', '--composed', 'probe'])
    expect(code).not.toBe(0)
    expect(stderr).toContain('composed with --managed')
    expect(lastBody).toBeUndefined()
  })
})
