import { expect, it } from 'vitest'
import { codexAppServerRequest } from './codex-app-server'

// A stand-in app-server: answers each request line by `reply(msg)`, and like
// the real one exits when its stdin closes.
function fakeServer(reply: string): string[] {
  const script = `
    const rl = require('node:readline').createInterface({ input: process.stdin })
    rl.on('line', (line) => {
      const msg = JSON.parse(line)
      if (msg.id === undefined) return
      const out = (${reply})(msg)
      if (out) process.stdout.write(JSON.stringify({ id: msg.id, ...out }) + '\\n')
    })
    rl.on('close', () => process.exit(0))
  `
  return [process.execPath, '-e', script]
}

it('returns the result of the request, after the handshake', async () => {
  const command = fakeServer(`(msg) =>
    msg.method === 'initialize' ? { result: {} } : { result: { method: msg.method, params: msg.params } }`)
  await expect(
    codexAppServerRequest('thread/read', { threadId: 't' }, { command }),
  ).resolves.toEqual({ method: 'thread/read', params: { threadId: 't' } })
})

it('rejects with the server’s error message', async () => {
  const command = fakeServer(`(msg) =>
    msg.method === 'initialize' ? { result: {} } : { error: { code: -1, message: 'no such thread' } }`)
  await expect(
    codexAppServerRequest('thread/read', { threadId: 't' }, { command }),
  ).rejects.toThrow('no such thread')
})

it('gives up when no reply arrives in time', async () => {
  const command = fakeServer('() => undefined')
  await expect(
    codexAppServerRequest('account/rateLimits/read', undefined, { command, timeoutMs: 200 }),
  ).rejects.toThrow('no reply')
})
