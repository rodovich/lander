import { defineConfig, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { localhostCert, WEB_PORT } from './webOrigin'
import { framePolicy } from './widget/viteFramePolicy'
import { widgetScript } from './widget/viteWidgetScript'

// Serve the dev UI over HTTPS when the localhost cert/key are present under
// data/ssl (symlinks to easel's shared self-signed cert; gitignored via data/).
// This keeps the dev origin on https://localhost:41414, matching easel — and is
// necessary because HSTS is host-scoped: once a browser has seen easel on
// https://localhost, it force-upgrades every localhost port, which would break a
// plain-http dev server. Vite serves its HMR socket over wss automatically when
// https is on. The /api proxy to the API server stays plain HTTP (loopback).
// If the files are missing (or the symlinks dangle), fall back to plain HTTP.
const https = localhostCert()
if (https) console.log('dev server: https via data/ssl/localhost.{crt,key}')
else console.warn('dev server: data/ssl/localhost.{crt,key} not found; serving http')

export function webConfig(api = 'http://localhost:6181'): UserConfig {
  return {
    plugins: [react(), framePolicy(api), widgetScript()],
    server: {
      port: WEB_PORT,
      strictPort: true,
      https,
      // Modules served here carry the UI token inlined, and Vite's default lets
      // any page on a localhost origin read them.
      cors: false,
      proxy: {
        '/api': api,
      },
    },
  }
}

export default defineConfig(webConfig())
