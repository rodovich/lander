import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeProjectPath, projectSlug, parseProjects } from './projects'

describe('normalizeProjectPath', () => {
  it('collapses slash runs to a single dash', () => {
    expect(normalizeProjectPath('/a//b')).toBe('a-b')
  })

  it('replaces disallowed characters with a dash', () => {
    expect(normalizeProjectPath('/a/b c@d')).toBe('a-b-c-d')
  })

  it('preserves case (the on-disk dir is case-sensitive)', () => {
    expect(normalizeProjectPath('/Users/Me')).toBe('Users-Me')
  })

  it('keeps dots, underscores and dashes', () => {
    expect(normalizeProjectPath('/a/b.c_d-e')).toBe('a-b.c_d-e')
  })

  it('trims leading and trailing dashes (e.g. from the leading slash)', () => {
    expect(normalizeProjectPath('/a/')).toBe('a')
  })

  it("returns 'default' when nothing survives slugification", () => {
    expect(normalizeProjectPath('/')).toBe('default')
    expect(normalizeProjectPath('///')).toBe('default')
  })

  it('resolves relative paths against cwd before slugifying', () => {
    expect(normalizeProjectPath('foo')).toBe(normalizeProjectPath(path.resolve('foo')))
  })
})

describe('projectSlug', () => {
  it('is the lowercased normalizeProjectPath', () => {
    expect(projectSlug('/Users/Me')).toBe('users-me')
    expect(projectSlug('/Users/Me')).toBe(normalizeProjectPath('/Users/Me').toLowerCase())
  })

  it('collapses case-only path variants to the same slug', () => {
    expect(projectSlug('/Users/Me')).toBe(projectSlug('/users/me'))
  })
})

describe('parseProjects', () => {
  const root = '/root/data'
  const dirs = (norm: string) => ({
    dataDir: path.join(root, norm, 'tasks'),
    runsDir: path.join(root, norm, 'runs'),
    archiveDir: path.join(root, norm, 'archived'),
    flowsDir: path.join(root, norm, 'flows'),
    attachmentsDir: path.join(root, norm, 'attachments'),
    hooksFile: path.join(root, norm, 'hooks.json'),
  })

  it('splits PROJECT_DIRS on newlines, trims, and drops empty lines', () => {
    const ps = parseProjects(root, { PROJECT_DIRS: '/a\n  /b  \n\n' }, '/cwd')
    expect(ps.map((p) => p.path)).toEqual(['/a', '/b'])
  })

  it('prefers PROJECT_DIRS over PROJECT_DIR over cwd', () => {
    expect(
      parseProjects(root, { PROJECT_DIRS: '/a', PROJECT_DIR: '/b' }, '/cwd').map(
        (p) => p.path,
      ),
    ).toEqual(['/a'])
    expect(parseProjects(root, { PROJECT_DIR: '/b' }, '/cwd').map((p) => p.path)).toEqual(
      ['/b'],
    )
    expect(parseProjects(root, {}, '/cwd').map((p) => p.path)).toEqual(['/cwd'])
  })

  it('reads the LANDER_PROJECTS_FILE list when PROJECT_DIRS is unset', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lander-projects-'))
    try {
      const file = path.join(dir, 'served-projects.txt')
      writeFileSync(file, '/x\n/y\n')
      const paths = (env: Record<string, string>) =>
        parseProjects(root, env, '/cwd').map((p) => p.path)
      expect(paths({ LANDER_PROJECTS_FILE: file, PROJECT_DIR: '/b' })).toEqual(['/x', '/y'])
      expect(paths({ LANDER_PROJECTS_FILE: file, PROJECT_DIRS: '/a' })).toEqual(['/a'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('builds the sibling dirs under <dataRoot>/<normalized>/', () => {
    const [p] = parseProjects(root, { PROJECT_DIRS: '/a' }, '/cwd')
    expect(p).toMatchObject({ path: '/a', slug: 'a', ...dirs('a') })
  })

  it('dedups on slug, keeping the first survivor (and its cased dirs)', () => {
    const ps = parseProjects(root, { PROJECT_DIRS: '/Project\n/project' }, '/cwd')
    expect(ps).toHaveLength(1)
    // The lowercased slug collides, but the kept entry is the first path, whose
    // on-disk dirs keep its original casing.
    expect(ps[0]).toMatchObject({ path: '/Project', slug: 'project', ...dirs('Project') })
  })

  it('makes the first parsed project the default', () => {
    const ps = parseProjects(root, { PROJECT_DIRS: '/first\n/second' }, '/cwd')
    expect(ps[0].path).toBe('/first')
  })
})
