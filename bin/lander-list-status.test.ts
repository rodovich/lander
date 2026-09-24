// `lander list --status` compares against the served status, and a value outside
// that vocabulary matches nothing. Since an empty result is also what a caller
// gets from a project with no such tasks, the two are indistinguishable unless
// the unrecognized value is rejected — so these cover the rejection, and cover
// that a valid value still reaches the filter.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const LANDER_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lander')

const base = { createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T01:00:00.000Z' }
const ACTIVE = [
  { ...base, id: 'act-1', title: 'Still going', status: 'riding' },
  { ...base, id: 'act-2', title: 'Idle', status: 'pacing' },
  { ...base, id: 'act-3', title: 'Done', status: 'landed' },
]

let server: Server
let port: number

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
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ tasks: ACTIVE, telemetry: {} }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

describe('lander list --status', () => {
  it('filters on a served status', async () => {
    const { stdout, code } = await execLander(['list', '--status', 'pacing'])
    expect(code).toBe(0)
    expect(stdout).toContain('act-2')
    expect(stdout).not.toContain('act-1')
  })

  it('accepts pacing, which no task file stores', async () => {
    // The stored value is `riding`; the server derives `pacing` from it. A
    // vocabulary taken from the stored enum would reject this.
    const { code } = await execLander(['list', '--status', 'pacing'])
    expect(code).toBe(0)
  })

  it('rejects a status outside the vocabulary instead of listing nothing', async () => {
    const { stdout, stderr, code } = await execLander(['list', '--status', 'active'])
    expect(code).not.toBe(0)
    expect(stderr).toContain('--status expects one of')
    expect(stdout).not.toContain('(no tasks)')
  })

  it('rejects a comma-delimited list, which matches no single row', async () => {
    const { stderr, code } = await execLander(['list', '--status', 'riding,pacing'])
    expect(code).not.toBe(0)
    expect(stderr).toContain('--status expects one of')
  })

  it('rejects --status with no value rather than listing everything', async () => {
    const { stdout, code } = await execLander(['list', '--status'])
    expect(code).not.toBe(0)
    expect(stdout).not.toContain('act-1')
  })
})
