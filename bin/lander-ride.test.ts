// `lander ride` reports the scheduled ride as the server resolved it. A `--time`
// is relative to a moment the session never sees, so the printed line is the
// turn's record of when it asked to wake. Driven against a stub server that
// answers with the scheduled task, since the server, not the CLI, resolves the
// time.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const LANDER_BIN = path.join(BIN_DIR, 'lander')
const AT = '2026-10-02T20:00:00.000Z'

let server: Server
let port: number
let reply: Record<string, unknown> = {}

function execLander(args: string[]): Promise<{ stdout: string; code: number }> {
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
        timeout: 10_000,
      },
      (error, stdout) =>
        resolve({ stdout, code: error && typeof error.code === 'number' ? error.code : 0 }),
    )
  })
}

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'task-1', ...reply }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

describe('lander ride', () => {
  const local = new Date(AT).toLocaleString()

  it('prints the time a scheduled ride will fire', async () => {
    reply = { scheduledFor: AT }
    const { stdout, code } = await execLander(['ride', '--time', '30'])
    expect(code).toBe(0)
    expect(stdout.trim()).toBe(`ride scheduled for ${local}`)
  })

  it('names the awaited tasks, and a time fallback', async () => {
    reply = { waitingFor: ['tsk-a', 'tsk-b'] }
    expect((await execLander(['ride', '--after', 'tsk-a,tsk-b'])).stdout.trim()).toBe(
      'ride scheduled for when tsk-a, tsk-b have all landed',
    )
    reply = { waitingFor: ['tsk-a'], scheduledFor: AT }
    expect(
      (await execLander(['ride', '--after', 'tsk-a', '--time', '30'])).stdout.trim(),
    ).toBe(`ride scheduled for ${local} or when tsk-a lands, whichever comes first`)
  })
})
