// Which pools `lander list` reads, and how a row from the archive is presented
// once both are in one listing. The pools are served by separate requests, so
// these assert on the requests the CLI makes as well as on what it prints —
// covering both a query that must span the two and one that must not.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const LANDER_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lander')

const ACTIVE = [
  {
    id: 'act-new',
    title: 'Newest active',
    status: 'landed',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
  },
  {
    id: 'act-old',
    title: 'Oldest active',
    status: 'riding',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
]
// Sorts between the two active rows, so a merge that simply concatenates the
// pools puts it in the wrong place.
const ARCHIVED = [
  {
    id: 'arc-mid',
    title: 'Archived middle',
    status: 'landed',
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  },
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
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
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
    const tasks = url.searchParams.get('archived') === '1' ? ARCHIVED : ACTIVE
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

describe('lander list pool selection', () => {
  it('reads both pools for --status landed', async () => {
    const { stdout, code } = await execLander(['list', '--status', 'landed'])
    expect(code).toBe(0)
    expect(seen.sort()).toEqual([
      '/api/proj/tasks?archived=1&view=summary',
      '/api/proj/tasks?view=summary',
    ])
    expect(stdout).toContain('arc-mid')
    expect(stdout).toContain('act-new')
    // Filtered, not merely merged.
    expect(stdout).not.toContain('act-old')
  })

  it('reads only the active pool for a live status', async () => {
    const { stdout, code } = await execLander(['list', '--status', 'riding'])
    expect(code).toBe(0)
    expect(seen).toEqual(['/api/proj/tasks?view=summary'])
    expect(stdout).toContain('act-old')
  })

  it('reads only the active pool when nothing is filtered', async () => {
    const { code } = await execLander(['list'])
    expect(code).toBe(0)
    expect(seen).toEqual(['/api/proj/tasks?view=summary'])
  })

  it('keeps a --text search on the active pool, whatever else it asks for', async () => {
    // Covering the archive for a text search means fetching the full projection
    // of every archived task — the payload ?view=summary exists to avoid.
    const { code } = await execLander(['list', '--status', 'landed', '--text', 'anything'])
    expect(code).toBe(0)
    expect(seen).toEqual(['/api/proj/tasks'])
  })

  it('reads only the archive for --archived', async () => {
    const { stdout, code } = await execLander(['list', '--archived'])
    expect(code).toBe(0)
    expect(seen).toEqual(['/api/proj/tasks?archived=1&view=summary'])
    expect(stdout).toContain('arc-mid')
    expect(stdout).not.toContain('act-new')
  })

  it('orders a merged listing newest first across both pools', async () => {
    const { stdout } = await execLander(['list', '--status', 'landed'])
    const rows = stdout.trim().split('\n')
    expect(rows.map((r) => r.split('  ')[0])).toEqual(['act-new', 'arc-mid'])
  })

  it('marks an archived row so the two pools stay distinguishable', async () => {
    const { stdout } = await execLander(['list', '--status', 'landed'])
    const rows = stdout.trim().split('\n')
    expect(rows.find((r) => r.startsWith('arc-mid'))).toContain('(archived)')
    expect(rows.find((r) => r.startsWith('act-new'))).not.toContain('(archived)')
  })

  it('marks it in --json too', async () => {
    const { stdout } = await execLander(['list', '--status', 'landed', '--json'])
    const meta = JSON.parse(stdout) as { id: string; archived?: boolean }[]
    expect(meta.find((t) => t.id === 'arc-mid')?.archived).toBe(true)
    expect(meta.find((t) => t.id === 'act-new')?.archived).toBeUndefined()
  })
})
