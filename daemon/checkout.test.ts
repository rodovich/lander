import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkoutBranch,
  checkoutPath,
  createTaskLocks,
  ensureCheckout,
  removeCheckout,
} from './checkout'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

describe('task checkouts', () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'lander-checkout-')))
    git(root, 'init', '-q', '-b', 'main')
    git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('lives at <root>/.worktrees/<task id>, and refuses an id that could walk out', () => {
    expect(checkoutPath('/p', 'abc_D-1')).toBe('/p/.worktrees/abc_D-1')
    expect(() => checkoutPath('/p', '../x')).toThrow(/unsafe task id/)
  })

  it('is created detached at the main checkout’s HEAD, and reused after', async () => {
    const head = git(root, 'rev-parse', 'HEAD')
    const dir = await ensureCheckout(root, 't1')
    expect(dir).toBe(path.join(root, '.worktrees', 't1'))
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(head)
    expect(checkoutBranch(dir)).toBeUndefined()
    // The main checkout is untouched, still on its branch.
    expect(git(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')

    writeFileSync(path.join(dir, 'work.txt'), 'x')
    expect(await ensureCheckout(root, 't1')).toBe(dir)
    expect(existsSync(path.join(dir, 'work.txt'))).toBe(true)
  })

  it('is recreated when its directory was deleted by hand but git still lists it', async () => {
    const dir = await ensureCheckout(root, 't1')
    rmSync(dir, { recursive: true, force: true })
    await ensureCheckout(root, 't1')
    expect(existsSync(path.join(dir, '.git'))).toBe(true)
  })

  it('refuses a directory in its place that is not a worktree', async () => {
    mkdirSync(path.join(root, '.worktrees', 't1'), { recursive: true })
    await expect(ensureCheckout(root, 't1')).rejects.toThrow(/is not a git worktree/)
  })

  it('reports the branch checked out in it', async () => {
    const dir = await ensureCheckout(root, 't1')
    git(dir, 'switch', '-q', '-c', 'feature/x')
    expect(checkoutBranch(dir)).toBe('feature/x')
    expect(checkoutBranch(path.join(root, 'nowhere'))).toBeUndefined()
  })

  it('is removed even when dirty or locked, leaving its branch', async () => {
    const dir = await ensureCheckout(root, 't1')
    git(dir, 'switch', '-q', '-c', 'keep-me')
    writeFileSync(path.join(dir, 'dirty.txt'), 'x')
    git(root, 'worktree', 'lock', dir)
    expect(await removeCheckout(root, 't1')).toBe(true)
    expect(existsSync(dir)).toBe(false)
    expect(git(root, 'branch', '--list', 'keep-me')).toContain('keep-me')
    // Nothing there now: a no-op.
    expect(await removeCheckout(root, 't1')).toBe(false)
  })

  it('takes a worktree the agent nested inside it along, leaving that branch too', async () => {
    const dir = await ensureCheckout(root, 't1')
    const inner = path.join(dir, '.claude', 'worktrees', 'inner')
    git(dir, 'worktree', 'add', '-q', '-b', 'worktree-inner', inner)
    git(root, 'worktree', 'lock', inner, '--reason', 'claude session inner')
    expect(await removeCheckout(root, 't1')).toBe(true)
    expect(git(root, 'worktree', 'list', '--porcelain')).not.toContain('.worktrees')
    expect(git(root, 'branch', '--list', 'worktree-inner')).toContain('worktree-inner')
  })
})

describe('createTaskLocks', () => {
  it('runs work for one key in order and different keys concurrently', async () => {
    const lock = createTaskLocks()
    const log: string[] = []
    let releaseA!: () => void
    const a = lock('k', async () => {
      await new Promise<void>((r) => (releaseA = r))
      log.push('a')
    })
    const b = lock('k', async () => {
      log.push('b')
    })
    const other = lock('other', async () => {
      log.push('other')
    })
    await other
    expect(log).toEqual(['other'])
    releaseA()
    await Promise.all([a, b])
    expect(log).toEqual(['other', 'a', 'b'])
  })

  it('keeps going after a failure', async () => {
    const lock = createTaskLocks()
    await expect(lock('k', async () => Promise.reject(new Error('x')))).rejects.toThrow('x')
    await expect(lock('k', async () => 'ok')).resolves.toBe('ok')
  })
})
