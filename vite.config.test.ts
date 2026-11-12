import { describe, expect, it, onTestFinished } from 'vitest'
import { serveApi, serveWeb } from './webTestServer'

describe('the web server', { timeout: 30_000 }, () => {
  const embed = 'embed.html?project=proj&task=t1'

  async function serve(answer: () => Response | Promise<Response> = () => Response.json({})) {
    const api = await serveApi(answer)
    onTestFinished(api.close)
    const web = await serveWeb(api.url)
    onTestFinished(web.close)
    const framePolicyOf = async (page: string) => {
      const response = await fetch(`${web.url}${page}`)
      await response.body?.cancel()
      expect(response.status).toBe(200)
      return response.headers.get('content-security-policy')
    }
    return { url: web.url, lookups: api.requests, framePolicyOf }
  }

  it('does not let a page on another localhost origin read its modules', async () => {
    const { url } = await serve()
    const response = await fetch(`${url}src/api.ts`, {
      headers: { origin: 'https://localhost:3000' },
    })
    await response.body?.cancel()
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('refuses to let another origin frame the main UI', async () => {
    const { framePolicyOf, lookups } = await serve(() =>
      Response.json({ app: { url: 'https://localhost:3860/' } }),
    )
    expect(await framePolicyOf('')).toBe("frame-ancestors 'self'")
    expect(lookups).toEqual([])
  })

  it('lets only the task’s own app frame the embed page', async () => {
    const { framePolicyOf, lookups } = await serve(() =>
      Response.json({ app: { url: 'https://localhost:3860/editor' } }),
    )
    expect(await framePolicyOf(embed)).toBe('frame-ancestors https://localhost:3860')
    expect(lookups).toEqual(['/api/proj/tasks/t1/app'])
  })

  it('serves the embed page’s entry module', async () => {
    const { url } = await serve(() => Response.json({ app: null }))
    const page = await (await fetch(`${url}${embed}`)).text()
    expect(page).toContain('/src/embedMain.tsx')
    const entry = await fetch(`${url}src/embedMain.tsx`)
    await entry.body?.cancel()
    expect(entry.status).toBe(200)
  })

  it('serves the widget as one classic script, with its styles inside', async () => {
    const { url } = await serve()
    const response = await fetch(`${url}widget.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript')
    const script = await response.text()
    expect(script).toContain('z-index: 2147483647')
    // A function body, like a classic script, can't hold import or export statements.
    expect(() => new Function(script)).not.toThrow()
  })

  it.each([
    ['has no app', () => Response.json({ app: null })],
    ['is unknown', () => Response.json({ error: 'task not found' }, { status: 404 })],
    ['cannot be asked about', () => Promise.reject(new Error('connection refused'))],
    ['is behind an unavailable daemon', () => Response.json({ error: 'restarting' }, { status: 503 })],
  ])('keeps the embed page same-origin when the task %s', async (_name, answer) => {
    const { framePolicyOf } = await serve(answer)
    expect(await framePolicyOf(embed)).toBe("frame-ancestors 'self'")
  })

  it('keeps a confirmed app able to frame the embed through an API restart, until told otherwise', async () => {
    let answer = (): Response | Promise<Response> =>
      Response.json({ app: { url: 'https://localhost:3860/' } })
    const { framePolicyOf } = await serve(() => answer())

    expect(await framePolicyOf(embed)).toBe('frame-ancestors https://localhost:3860')
    answer = () => Promise.reject(new Error('connection refused'))
    expect(await framePolicyOf(embed)).toBe('frame-ancestors https://localhost:3860')
    answer = () => Response.json({ app: null })
    expect(await framePolicyOf(embed)).toBe("frame-ancestors 'self'")
    answer = () => Promise.reject(new Error('connection refused'))
    expect(await framePolicyOf(embed)).toBe("frame-ancestors 'self'")
  })
})
