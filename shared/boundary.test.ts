import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Code here runs in the browser and in the server alike, so at runtime it may
// import only itself. Types are erased, so it may name the client's item types,
// which mirror the server's.
const dir = path.dirname(fileURLToPath(import.meta.url))
const sources = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))

describe('shared/', () => {
  it.each(sources)('%s imports nothing but shared code and types', (file) => {
    const text = readFileSync(path.join(dir, file), 'utf8')
    const imports = [
      ...text.matchAll(/^(?:import|export)\s+(type\s+)?(?:[^;'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gms),
    ]
    for (const [statement, typeOnly, from] of imports)
      expect(
        /^\.\/[\w-]+$/.test(from) || (typeOnly && from === '../src/types'),
        statement,
      ).toBe(true)
  })
})
