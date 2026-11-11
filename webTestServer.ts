import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type InlineConfig } from 'vite'
import { webConfig } from './vite.config'

export type TestServer = { url: string; close: () => Promise<void> }

// A stand-in for lander's API server.
export async function serveApi(
  answer: (path: string) => Response | Promise<Response>,
): Promise<TestServer & { requests: string[] }> {
  const requests: string[] = []
  const server = http.createServer(async (req, res) => {
    requests.push(req.url ?? '')
    try {
      const response = await answer(req.url ?? '')
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(await response.text())
    } catch {
      req.socket.destroy()
    }
  })
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  }
}

export async function serveWeb(
  api: string,
  optimizeDeps: InlineConfig['optimizeDeps'] = { noDiscovery: true },
): Promise<TestServer> {
  const config = webConfig(api)
  // Its own cache, so this can't disturb the running dev server's.
  const cacheDir = mkdtempSync(path.join(tmpdir(), 'lander-vite-'))
  const vite = await createServer({
    ...config,
    configFile: false,
    cacheDir,
    logLevel: 'silent',
    optimizeDeps,
    server: {
      ...config.server,
      https: undefined,
      host: '127.0.0.1',
      port: 0,
      hmr: false,
      ws: false,
      watch: null,
    },
  })
  await vite.listen()
  return {
    url: vite.resolvedUrls!.local[0],
    close: async () => {
      await vite.close()
      rmSync(cacheDir, { recursive: true, force: true })
    },
  }
}
