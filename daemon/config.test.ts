import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configPath,
  createProjectOptions,
  devProjectPaths,
  parseConfig,
  readConfig,
} from './config'

const FILE = '/cfg/config.json'

describe('parseConfig', () => {
  it('resolves paths, expands ~, and defaults worktrees off', () => {
    const cfg = parseConfig(
      JSON.stringify({
        projects: [
          { path: '~/code/app', worktrees: true },
          { path: '/abs/other/' },
          { path: '~' },
        ],
      }),
      FILE,
      '/home/me',
    )
    expect(cfg.projects).toEqual([
      { path: '/home/me/code/app', worktrees: true },
      { path: '/abs/other', worktrees: false },
      { path: '/home/me', worktrees: false },
    ])
  })

  it.each([
    ['not json', /config\.json: not valid JSON/],
    ['[]', /expected an object/],
    ['{}', /expected a "projects" array/],
    ['{"projects":[1]}', /projects\[0\] must be an object/],
    ['{"projects":[{"path":""}]}', /projects\[0\]\.path must be a non-empty string/],
    [
      '{"projects":[{"path":"/a","worktrees":"yes"}]}',
      /projects\[0\]\.worktrees must be true or false/,
    ],
  ])('rejects %s, naming the file', (text, message) => {
    expect(() => parseConfig(text, FILE)).toThrow(message)
  })
})

describe('configPath', () => {
  it('honors LANDER_CONFIG, else ~/.lander/config.json', () => {
    expect(configPath({ LANDER_CONFIG: '/x/y.json' })).toBe('/x/y.json')
    expect(configPath({})).toMatch(/\.lander\/config\.json$/)
  })
})

describe('reading the file', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })
  const tmp = () => (dir = mkdtempSync(path.join(tmpdir(), 'lander-config-')))

  it('readConfig is undefined for a missing file', () => {
    expect(readConfig(path.join(tmp(), 'missing.json'))).toBeUndefined()
  })

  it('devProjectPaths prefers argv, else the config, else explains', () => {
    const file = path.join(tmp(), 'config.json')
    expect(devProjectPaths(['/a/', 'b'], file)).toEqual([
      '/a',
      path.resolve('b'),
    ])
    expect(() => devProjectPaths([], file)).toThrow(/no projects: list them in/)
    writeFileSync(file, JSON.stringify({ projects: [{ path: '/x', worktrees: true }] }))
    expect(devProjectPaths([], file)).toEqual(['/x'])
    writeFileSync(file, '{')
    expect(() => devProjectPaths([], file)).toThrow(/config\.json: not valid JSON/)
  })

  it('createProjectOptions follows edits, keeps the last good read, and forgets a removed file', () => {
    const file = path.join(tmp(), 'config.json')
    const logs: string[] = []
    const options = createProjectOptions(file, (m) => logs.push(m))
    expect(options.worktrees('/p')).toBe(false)

    // Each write gets a distinct mtime so the cache can't mistake it for the last.
    let tick = 1_000_000
    const write = (text: string) => {
      writeFileSync(file, text)
      tick += 10
      utimesSync(file, tick, tick)
    }

    write(JSON.stringify({ projects: [{ path: '/p', worktrees: true }] }))
    expect(options.worktrees('/p')).toBe(true)
    expect(options.worktrees('/p/')).toBe(true)
    expect(options.worktrees('/q')).toBe(false)

    write('{ half-saved')
    expect(options.worktrees('/p')).toBe(true)
    expect(logs.join('\n')).toMatch(/keeping the last good read/)

    write(JSON.stringify({ projects: [{ path: '/p' }] }))
    expect(options.worktrees('/p')).toBe(false)

    rmSync(file)
    expect(options.worktrees('/p')).toBe(false)
  })
})
