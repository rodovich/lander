import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import config, { API } from './vite.config'

describe('the web server', { timeout: 30_000 }, () => {
  afterEach(() => vi.restoreAllMocks())

  // The tests' own requests go through this same fetch.
  function stubApi(answer: () => Response | Promise<Response>) {
    const real = globalThis.fetch
    const stub = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      String(input).startsWith(API) ? Promise.resolve().then(answer) : real(input, init),
    )
    return () => stub.mock.calls.map(([input]) => String(input)).filter((url) => url.startsWith(API))
  }

  const framePolicyOf = async (page: string) => {
    const response = await fetch(`${await serve()}${page}`)
    await response.body?.cancel()
    expect(response.status).toBe(200)
    return response.headers.get('content-security-policy')
  }

  const embed = 'embed.html?project=proj&task=t1'

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

  it('refuses to let another origin frame the main UI', async () => {
    const lookups = stubApi(() => Response.json({ app: { url: 'https://localhost:3860/' } }))
    expect(await framePolicyOf('')).toBe("frame-ancestors 'self'")
    expect(lookups()).toEqual([])
  })

  it('lets only the task’s own app frame the embed page', async () => {
    const lookups = stubApi(() => Response.json({ app: { url: 'https://localhost:3860/editor' } }))
    expect(await framePolicyOf(embed)).toBe('frame-ancestors https://localhost:3860')
    expect(lookups()).toEqual([`${API}/api/proj/tasks/t1/app`])
  })

  it('serves the embed page’s entry module', async () => {
    stubApi(() => Response.json({ app: null }))
    const base = await serve()
    const page = await (await fetch(`${base}${embed}`)).text()
    expect(page).toContain('/src/embedMain.tsx')
    const entry = await fetch(`${base}src/embedMain.tsx`)
    await entry.body?.cancel()
    expect(entry.status).toBe(200)
  })

  it.each([
    ['has no app', () => Response.json({ app: null })],
    ['is unknown', () => Response.json({ error: 'task not found' }, { status: 404 })],
    ['cannot be asked about', () => Promise.reject(new Error('connection refused'))],
    ['is behind an unavailable daemon', () => Response.json({ error: 'restarting' }, { status: 503 })],
  ])('keeps the embed page same-origin when the task %s', async (_name, answer) => {
    stubApi(answer)
    expect(await framePolicyOf(embed)).toBe("frame-ancestors 'self'")
  })

  it('keeps a confirmed app able to frame the embed through an API restart, until told otherwise', async () => {
    let answer = (): Response | Promise<Response> =>
      Response.json({ app: { url: 'https://localhost:3860/' } })
    stubApi(() => answer())
    const base = await serve()
    const policy = async () => {
      const response = await fetch(`${base}${embed}`)
      await response.body?.cancel()
      return response.headers.get('content-security-policy')
    }

    expect(await policy()).toBe('frame-ancestors https://localhost:3860')
    answer = () => Promise.reject(new Error('connection refused'))
    expect(await policy()).toBe('frame-ancestors https://localhost:3860')
    answer = () => Response.json({ app: null })
    expect(await policy()).toBe("frame-ancestors 'self'")
    answer = () => Promise.reject(new Error('connection refused'))
    expect(await policy()).toBe("frame-ancestors 'self'")
  })
})
