// The git worktree the daemon manages for a task in a project that enables them
// (`worktrees: true` in the lander config): `<root>/.worktrees/<task id>`. Its
// location is a pure function of the project and the task, so nothing about it
// has to be stored anywhere — the server keeps only the branch it last saw.
//
// Created detached at whatever the main checkout has checked out, when a ride
// starts and finds none; removed, branches untouched, when the task is landed or
// archived. Nothing here knows anything about any particular project.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

export const CHECKOUTS_DIR = '.worktrees'

// Task ids are the server's nanoids; anything else would be joined into a path
// we then hand to `git worktree remove --force`, so refuse it outright.
const SAFE_ID = /^[A-Za-z0-9_-]+$/

export function checkoutPath(root: string, taskId: string): string {
  if (!SAFE_ID.test(taskId)) throw new Error(`unsafe task id for a checkout: ${taskId}`)
  return path.join(root, CHECKOUTS_DIR, taskId)
}

// A linked worktree carries a `.git` FILE pointing at its gitdir. A directory
// without one is not a checkout we can launch in: git run there would walk up
// to the main checkout and commit onto its branch.
function isWorktree(dir: string): boolean {
  return existsSync(path.join(dir, '.git'))
}

// Runs git in `cwd`, resolving with its stdout.
export type Git = (cwd: string, args: string[]) => Promise<string>

export const gitRun: Git = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 1 << 20 }, (err, out, stderr) => {
      if (err) reject(new Error(String(stderr).trim() || err.message))
      else resolve(String(out))
    })
  })

// Make sure the task's checkout exists. `-f` overrides only a registered entry
// whose directory has gone missing (deleted by hand); with `--detach` there is no
// branch for it to steal.
export async function ensureCheckout(
  root: string,
  taskId: string,
  git: Git = gitRun,
): Promise<string> {
  const dir = checkoutPath(root, taskId)
  if (existsSync(dir)) {
    if (isWorktree(dir)) return dir
    throw new Error(`${dir} exists but is not a git worktree; move it aside to let this task run`)
  }
  await git(root, ['worktree', 'add', '-f', '--detach', dir])
  return dir
}

// Remove the task's checkout if there is one. Twice `--force`: once for a dirty
// tree (landing means done, and its branches stay), twice for a lock some tool
// left behind.
//
// Worktrees an agent made inside it go first, deepest first — Claude's
// EnterWorktree puts one at `<checkout>/.claude/worktrees/<name>`. Removing only
// the outer tree deletes their files but leaves their registrations, locked by
// the session that made them, so `git worktree prune` won't clear them and their
// branches can't be deleted until someone unlocks them by hand.
export async function removeCheckout(
  root: string,
  taskId: string,
  git: Git = gitRun,
): Promise<boolean> {
  const dir = checkoutPath(root, taskId)
  if (!existsSync(dir)) return false
  // Git lists real paths (macOS's /tmp is /private/tmp), so compare those.
  const inside = realpathSync(dir) + path.sep
  const nested = worktreePaths(await git(root, ['worktree', 'list', '--porcelain']))
    .filter((p) => p.startsWith(inside))
    .sort((a, b) => b.length - a.length)
  for (const p of nested) await git(root, ['worktree', 'remove', '--force', '--force', p])
  await git(root, ['worktree', 'remove', '--force', '--force', dir])
  return true
}

function worktreePaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}

// The branch checked out in a checkout, or undefined when HEAD is detached or
// unreadable. Read straight from the files — `.git` names the gitdir, whose HEAD
// is `ref: refs/heads/<name>` or a bare sha — so a run's done never waits on a
// git process.
export function checkoutBranch(dir: string): string | undefined {
  try {
    const gitFile = readFileSync(path.join(dir, '.git'), 'utf8').trim()
    const m = /^gitdir:\s*(.+)$/.exec(gitFile)
    if (!m) return undefined
    const gitdir = path.resolve(dir, m[1])
    const head = readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
    return ref ? ref[1] : undefined
  } catch {
    return undefined
  }
}

// Serialize work on one task's checkout — a land's remove and an unland-and-
// reply's create must not interleave — while different tasks proceed in
// parallel.
export function createTaskLocks(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>()
  return (key, fn) => {
    const prev = tails.get(key) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    tails.set(key, next)
    void next
      .catch(() => {})
      .finally(() => {
        if (tails.get(key) === next) tails.delete(key)
      })
    return next
  }
}
