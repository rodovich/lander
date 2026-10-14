// `lander view` prints the conversation the server renders for it, windowed to
// the last few blocks. Driven against a stub server that records what was asked
// and answers with a canned conversation.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const LANDER_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lander')

let server: Server
let port: number
let lastUrl = ''

const LONG = 'y'.repeat(3000)
const conversation = [
  ...Array.from({ length: 7 }, (_, i) => ({ role: 'user', text: `message ${i}` })),
  { role: 'assistant', text: `Starting.\n\n[2 steps, 1 tool…]\n\n${LONG}`, folded: true },
]

function execLander(args: string[]): Promise<string> {
  lastUrl = ''
  return new Promise((resolve, reject) => {
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
          LANDER_VIEW_MESSAGES: '',
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })
}

beforeAll(async () => {
  server = createServer((req, res) => {
    lastUrl = req.url ?? ''
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'child-1',
          title: 'Child',
          status: 'paced',
          allowEdits: false,
          items: [],
          conversation,
        }),
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

describe('lander view', () => {
  it('asks for the folded conversation and prints the last six blocks unclipped', async () => {
    const out = await execLander(['view', 'child-1'])
    expect(lastUrl).toBe('/api/proj/tasks/child-1?conversation=folded')
    expect(out).not.toContain('message 1\n')
    expect(out).toContain('message 2')
    expect(out).toContain(LONG)
    expect(out).toContain(
      '… 2 earlier messages hidden, turns folded — to see more: lander view child-1 --messages all --expand',
    )
  })

  it('asks for the expanded conversation with --expand, or its older name --tools', async () => {
    await execLander(['view', 'child-1', '--expand'])
    expect(lastUrl).toBe('/api/proj/tasks/child-1?conversation=expanded')
    await execLander(['view', '--tools', 'child-1'])
    expect(lastUrl).toBe('/api/proj/tasks/child-1?conversation=expanded')
  })

  it('clips only when asked', async () => {
    const out = await execLander(['view', 'child-1', '--messages', '1', '--clip', '20'])
    expect(out).toContain('assistant:\nStarting.\n\n[2 steps,…')
    expect(out).toContain('7 earlier messages hidden, 1 clipped, turns folded')
  })
})
