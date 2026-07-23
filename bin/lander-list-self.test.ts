// `lander list` and `lander view` must flag the caller's own task so an agent
// can't mistake its own row for a separate one. The bug this guards against:
// agents that ran `lander list`, saw their own entry, and — primed by the
// "sibling task" framing — treated themselves as a competing sibling (e.g.
// x6lq_MVk5T warned the user to "dedupe before both of us edit bin/lander",
// where the other task WAS itself; N6fe_Xa2Tw did the same after a relaunch).
// The caller is LANDER_TASK = 'task-1' here.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const LANDER_BIN = path.join(BIN_DIR, 'lander')

const TASKS = [
  { id: 'task-1', title: 'Me myself', status: 'riding', createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T01:00:00.000Z' },
  { id: 'task-2', title: 'A real sibling', status: 'landed', createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T01:00:00.000Z' },
]

let server: Server
let port: number

function execLander(args: string[], task = 'task-1'): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [LANDER_BIN, ...args],
      {
        env: {
          ...process.env,
          LANDER_API: `http://127.0.0.1:${port}`,
          LANDER_PROJECT: 'proj',
          LANDER_TASK: task,
          LANDER_TOKEN: 'tok',
        },
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
      },
      (error, stdout, stderr) =>
        resolve({ stdout, stderr, code: error && typeof error.code === 'number' ? error.code : 0 }),
    )
  })
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x')
    const m = url.pathname.match(/^\/api\/proj\/tasks\/(.+)$/)
    res.writeHead(200, { 'content-type': 'application/json' })
    if (m) {
      const t = TASKS.find((x) => x.id === m[1])
      res.end(JSON.stringify(t ? { ...t, items: [], allowEdits: false } : {}))
    } else {
      res.end(JSON.stringify(TASKS))
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

describe('lander list self-marking', () => {
  it('marks the caller row and only the caller row', async () => {
    const { stdout, code } = await execLander(['list'])
    expect(code).toBe(0)
    const rows = stdout.trim().split('\n')
    const mine = rows.find((r) => r.startsWith('task-1'))
    const other = rows.find((r) => r.startsWith('task-2'))
    expect(mine).toContain('← this task')
    expect(other).not.toContain('← this task')
  })

  it('marks whichever task is the caller (task-2 when it runs the command)', async () => {
    const { stdout } = await execLander(['list'], 'task-2')
    const rows = stdout.trim().split('\n')
    expect(rows.find((r) => r.startsWith('task-2'))).toContain('← this task')
    expect(rows.find((r) => r.startsWith('task-1'))).not.toContain('← this task')
  })

  it('--json flags the caller with self:true and nobody else', async () => {
    const { stdout, code } = await execLander(['list', '--json'])
    expect(code).toBe(0)
    const meta = JSON.parse(stdout)
    expect(meta.find((t: { id: string }) => t.id === 'task-1').self).toBe(true)
    expect(meta.find((t: { id: string }) => t.id === 'task-2').self).toBeUndefined()
  })
})

describe('lander view self-marking', () => {
  it('marks the id line when viewing the caller task', async () => {
    const { stdout, code } = await execLander(['view', 'task-1'])
    expect(code).toBe(0)
    expect(stdout).toContain('id: task-1  ← this task')
  })

  it('does not mark the id line when viewing another task', async () => {
    const { stdout } = await execLander(['view', 'task-2'])
    expect(stdout).toContain('id: task-2')
    expect(stdout).not.toContain('← this task')
  })
})
