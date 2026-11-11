import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { describe, expect, it, onTestFinished } from 'vitest'
import config from './vite.config'

describe('the web server', { timeout: 30_000 }, () => {
  async function serve(): Promise<string> {
    // Its own cache, so this can't disturb the running dev server's.
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'lander-vite-'))
    onTestFinished(() => rmSync(cacheDir, { recursive: true, force: true }))
    const vite = await createServer({
      ...config,
      configFile: false,
      cacheDir,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      server: {
        ...config.server,
        https: undefined,
        proxy: undefined,
        host: '127.0.0.1',
        port: 0,
        hmr: false,
        ws: false,
        watch: null,
      },
    })
    onTestFinished(() => vite.close())
    await vite.listen()
    return vite.resolvedUrls!.local[0]
  }

  it('does not let a page on another localhost origin read its modules', async () => {
    const response = await fetch(`${await serve()}src/api.ts`, {
      headers: { origin: 'https://localhost:3000' },
    })
    await response.body?.cancel()
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})
