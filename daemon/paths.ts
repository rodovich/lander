import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Whether `p` lies strictly under `dir`. Lexical: resolve symlinks first where
// they matter.
export function isSafePathSegment(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..'
}

export function isInside(dir: string, p: string): boolean {
  const rel = path.relative(dir, p)
  return (
    !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  )
}

// Lander's install root, independent of the project a task runs against.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
