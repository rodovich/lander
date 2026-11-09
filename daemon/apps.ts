import { readFileSync, statSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { parseEnv } from 'node:util'
import type { AppStatus } from '../server/protocol'
import type { AppConfig } from './config'

const CONNECT_TIMEOUT_MS = 1_000

function readEnvFile(file: string): Record<string, string | undefined> {
  try {
    // A FIFO an agent left here would block a read, and with it the daemon.
    return statSync(file).isFile() ? parseEnv(readFileSync(file, 'utf8')) : {}
  } catch {
    return {}
  }
}

// Reads the env file as text and runs nothing, because this happens whenever a
// task is viewed and agents can edit the checkout.
export function appUrl(app: AppConfig, checkout: string): string | undefined {
  const vars = app.envFile ? readEnvFile(path.join(checkout, app.envFile)) : {}
  let missing = false
  const text = app.url.replace(/\$\{(\w+)\}/g, (_, name: string) => {
    if (vars[name] === undefined) missing = true
    return vars[name] ?? ''
  })
  if (missing || !URL.canParse(text)) return undefined
  return ['http:', 'https:'].includes(new URL(text).protocol) ? text : undefined
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const finish = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

// Dev servers commonly bind only one address family for `localhost`.
export async function isListening(url: string): Promise<boolean> {
  const { hostname, port, protocol } = new URL(url)
  const hosts =
    hostname === 'localhost' ? ['127.0.0.1', '::1'] : [hostname.replace(/^\[|\]$/g, '')]
  const portNumber = Number(port) || (protocol === 'https:' ? 443 : 80)
  const results = await Promise.all(hosts.map((h) => canConnect(h, portNumber)))
  return results.includes(true)
}

export async function appStatus(app: AppConfig, checkout: string): Promise<AppStatus> {
  const url = appUrl(app, checkout)
  return url ? { url, listening: await isListening(url) } : { listening: false }
}
