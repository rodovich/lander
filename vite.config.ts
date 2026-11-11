import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { framePolicy } from './viteFramePolicy'

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

export const API = 'http://localhost:6181'

export default defineConfig({
  plugins: [react(), framePolicy(API)],
  server: {
    port: 41414,
    strictPort: true,
    https,
    // Modules served here carry the UI token inlined, and Vite's default lets
    // any page on a localhost origin read them.
    cors: false,
    proxy: {
      '/api': API,
    },
  },
})
