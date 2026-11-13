import { fileURLToPath } from 'node:url'
import { build, type Plugin, type Rolldown } from 'vite'

const ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url))

// An app's page loads the widget as a classic script, which needs no CORS from
// lander but can't import, so it must arrive as one bundle. Building that on
// each request keeps it current without a watcher.
export function widgetScript(): Plugin {
  return {
    name: 'lander-widget-script',
    configureServer(server) {
      server.middlewares.use('/widget.js', async (_req, res) => {
        try {
          const output = (await build({
            configFile: false,
            logLevel: 'silent',
            publicDir: false,
            build: {
              write: false,
              minify: false,
              rolldownOptions: { input: ENTRY, output: { format: 'iife' } },
            },
          })) as Rolldown.RolldownOutput
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
          res.setHeader('Cache-Control', 'no-cache')
          res.end(output.output[0].code)
        } catch (error) {
          // A page shows nothing of a script that failed to load.
          server.config.logger.error(`lander widget: ${String(error)}`)
          res.statusCode = 500
          res.end()
        }
      })
    },
  }
}
