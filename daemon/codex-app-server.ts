// One request to Codex's app-server (`codex app-server`, JSON-RPC over stdio):
// start it, handshake, send the request, and stop it once the reply arrives.
// The protocol's schema comes from `codex app-server generate-json-schema`.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const REQUEST_ID = 1

export async function codexAppServerRequest(
  method: string,
  params: unknown,
  {
    timeoutMs = 30_000,
    command = ['codex', 'app-server'],
  }: { timeoutMs?: number; command?: string[] } = {},
): Promise<unknown> {
  const [cmd, ...args] = command
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] })
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`codex app-server: no reply to ${method} in ${timeoutMs}ms`)),
        timeoutMs,
      )
      const settle = (fn: () => void) => {
        clearTimeout(timer)
        fn()
      }
      child.on('error', (e) => settle(() => reject(e)))
      // A codex that failed to start (not installed) breaks the pipe the writes
      // below go to; the spawn error above is the one to report.
      child.stdin.on('error', () => {})
      // The server exits when its stdin closes, even with a request pending, so
      // stdin stays open until the reply is in.
      child.on('close', (code) =>
        settle(() =>
          reject(new Error(`codex app-server exited (${code}) before replying to ${method}`)),
        ),
      )
      createInterface({ input: child.stdout }).on('line', (line) => {
        let msg: { id?: unknown; result?: unknown; error?: { message?: unknown } }
        try {
          msg = JSON.parse(line)
        } catch {
          return
        }
        if (msg.id !== REQUEST_ID) return
        settle(() =>
          msg.error
            ? reject(new Error(`codex app-server ${method}: ${String(msg.error.message)}`))
            : resolve(msg.result),
        )
      })
      const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`)
      send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'lander', version: '0' } } })
      send({ method: 'initialized' })
      send({ id: REQUEST_ID, method, params })
    })
  } finally {
    child.stdin.end()
    child.kill()
  }
}
