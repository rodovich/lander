import type { Plugin } from 'vite'
import { taskKey, taskRefFromQuery } from '../src/taskRef'

const SAME_ORIGIN = "'self'"

export function framePolicy(api: string): Plugin {
  // A frame refused during an API or daemon restart can't recover on its own,
  // so a failed lookup falls back on the last origin a lookup confirmed.
  const confirmed = new Map<string, string>()

  async function frameAncestor(requestUrl: string): Promise<string> {
    let key: string | undefined
    try {
      const { pathname, search } = new URL(requestUrl, 'http://localhost')
      const ref = pathname === '/embed.html' ? taskRefFromQuery(search) : null
      if (!ref) return SAME_ORIGIN
      key = taskKey(ref.projectSlug, ref.id)
      const response = await fetch(
        `${api}/api/${encodeURIComponent(ref.projectSlug)}/tasks/${encodeURIComponent(ref.id)}/app`,
      )
      if (response.status >= 500) throw new Error(`HTTP ${response.status}`)
      const { app } = (await response.json()) as { app?: { url?: string } | null }
      if (!app?.url) {
        confirmed.delete(key)
        return SAME_ORIGIN
      }
      const origin = new URL(app.url).origin
      confirmed.set(key, origin)
      return origin
    } catch {
      return (key && confirmed.get(key)) || SAME_ORIGIN
    }
  }

  return {
    name: 'lander-frame-policy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? '/'
        if (!url.startsWith('/api/'))
          res.setHeader('Content-Security-Policy', `frame-ancestors ${await frameAncestor(url)}`)
        next()
      })
    },
  }
}
