// `lander list` asks the server for metadata-only rows (`?view=summary`), since
// the printed row is metadata and the full list is ~99% conversation. Two things
// have to hold: the query is composed correctly alongside `?archived=1`, and
// --text still opts back into the full list — it searches message text, which a
// summary does not carry, so a summarized --text would silently match nothing.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const LANDER_BIN = path.join(BIN_DIR, 'lander')

const base = {
  status: 'resting',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T01:00:00.000Z',
}
const ACTIVE = [
  { ...base, id: 'act-1', title: 'Active one' },
  { ...base, id: 'act-2', title: 'Active two' },
]
const ARCHIVED = [{ ...base, id: 'arc-1', title: 'Archived one' }]
// The conversation the full projection carries and the summary does not.
const items = (text: string) => [
  { id: 'i1', at: base.updatedAt, kind: 'message', role: 'user', text },
]

let server: Server
let port: number
let seen: string[]

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
          LANDER_TASK: 'caller',
          LANDER_TOKEN: 'tok',
        },
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        // Any failure reports non-zero. A child killed by the timeout above
        // carries a `signal` and no numeric `code`, and a spawn failure carries
        // a string one (ENOENT) — reporting either as 0 would let every
        // `expect(code).toBe(0)` below pass for a CLI that never ran.
        const err = error as (Error & { code?: number | string }) | null
        resolve({ stdout, stderr, code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 })
      },
    )
  })
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x')
    seen.push(req.url ?? '')
    const archived = url.searchParams.get('archived') === '1'
    const summary = url.searchParams.get('view') === 'summary'
    const tasks = (archived ? ARCHIVED : ACTIVE).map((t) =>
      summary ? { ...t } : { ...t, items: items(`the body of ${t.id} mentions pomegranate`) },
    )
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ tasks, telemetry: {} }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

beforeEach(() => {
  seen = []
})

describe('lander list request composition', () => {
  it('asks for a summary', async () => {
    const { stdout, code } = await execLander(['list'])
    expect(code).toBe(0)
    expect(seen).toEqual(['/api/proj/tasks?view=summary'])
    expect(stdout).toContain('act-1')
  })

  it('appends the summary to ?archived=1 with one ? and one &', async () => {
    const { stdout, code } = await execLander(['list', '--archived'])
    expect(code).toBe(0)
    expect(seen).toEqual(['/api/proj/tasks?archived=1&view=summary'])
    expect(stdout).toContain('arc-1')
  })

  it('keeps the full list for --text, which searches message bodies', async () => {
    const { stdout, code } = await execLander(['list', '--text', 'pomegranate'])
    expect(code).toBe(0)
    expect(seen).toEqual(['/api/proj/tasks'])
    // The term appears nowhere in any title — only in the conversation the full
    // projection carries, so a match proves the CLI still fetched it.
    expect(stdout).toContain('act-1')
    expect(stdout).toContain('act-2')
  })

  it('keeps the full archived list for --text too', async () => {
    const { code } = await execLander(['list', '--archived', '--text', 'pomegranate'])
    expect(code).toBe(0)
    expect(seen).toEqual(['/api/proj/tasks?archived=1'])
  })

  it('never prints the conversation it fetched for --text', async () => {
    const { stdout, code } = await execLander(['list', '--text', 'pomegranate', '--json'])
    // Paired with the positives: an absence alone is satisfied by printing
    // nothing at all, so a CLI that died on entry would pass the assertion that
    // matters here without ever having printed a row.
    expect(code).toBe(0)
    expect(stdout).toContain('act-1')
    expect(stdout).toContain('act-2')
    expect(stdout).not.toContain('pomegranate')
  })
})
