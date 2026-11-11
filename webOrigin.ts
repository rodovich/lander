import { readFileSync } from 'node:fs'

export const WEB_PORT = 41414

export function localhostCert(): { key: Buffer; cert: Buffer } | undefined {
  try {
    return {
      key: readFileSync(new URL('./data/ssl/localhost.key', import.meta.url)),
      cert: readFileSync(new URL('./data/ssl/localhost.crt', import.meta.url)),
    }
  } catch {
    return undefined
  }
}

export function webOrigin(): string {
  return `${localhostCert() ? 'https' : 'http'}://localhost:${WEB_PORT}`
}
