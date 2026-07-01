import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'

// Serve the dev UI over HTTPS when the localhost cert/key are present under
// data/ssl (symlinks to easel's shared self-signed cert; gitignored via data/).
// This keeps the dev origin on https://localhost:41414, matching easel — and is
// necessary because HSTS is host-scoped: once a browser has seen easel on
// https://localhost, it force-upgrades every localhost port, which would break a
// plain-http dev server. Vite serves its HMR socket over wss automatically when
// https is on. The /api proxy to the API server stays plain HTTP (loopback).
// If the files are missing (or the symlinks dangle), fall back to plain HTTP.
let https
try {
  https = {
    key: readFileSync(new URL('./data/ssl/localhost.key', import.meta.url)),
    cert: readFileSync(new URL('./data/ssl/localhost.crt', import.meta.url)),
  }
  console.log('dev server: https via data/ssl/localhost.{crt,key}')
} catch {
  console.warn('dev server: data/ssl/localhost.{crt,key} not found; serving http')
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 41414,
    strictPort: true,
    https,
    proxy: {
      '/api': 'http://localhost:6181',
    },
  },
})
