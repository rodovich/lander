// The git worktree the daemon manages for a task in a project that enables them
// (`worktrees: true` in the lander config): `<root>/.worktrees/<task id>`. Its
// location is a pure function of the project and the task, so nothing about it
// has to be stored for the daemon to find it again — the server keeps the last
// report of it only to show.
//
// Created detached at whatever the main checkout has checked out, when a ride
// starts and finds none; removed, branches untouched, when the task is landed or
// archived. Nothing here knows anything about any particular project.

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { ChangedFile, CheckoutReport } from '../server/protocol'

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

// A Git that kills a command still running after `timeoutMs`; 0 never does.
export const gitWithin =
  (timeoutMs: number): Git =>
  (cwd, args) =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-C', cwd, ...args],
        { maxBuffer: 1 << 20, timeout: timeoutMs },
        (err, out, stderr) => {
          if (err) reject(new Error(String(stderr).trim() || err.message))
          else resolve(String(out))
        },
      )
    })

export const gitRun: Git = gitWithin(0)

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
// unreadable.
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

export async function checkoutReport(
  root: string,
  dir: string,
  git: Git = gitRun,
): Promise<CheckoutReport> {
  const branch = checkoutBranch(dir)
  return {
    path: dir,
    ...(branch ? { branch } : {}),
    files: await checkoutChanges(root, dir, git),
  }
}

// A fetched upstream may include commits the task started from that the main
// checkout hasn't incorporated yet. Keep local commits authoritative when the
// main checkout and its upstream have diverged.
async function checkoutComparisonHead(root: string, git: Git): Promise<string> {
  let revisions: string[]
  try {
    revisions = (await git(root, ['rev-parse', 'HEAD', '@{upstream}'])).trim().split('\n')
  } catch {
    return (await git(root, ['rev-parse', 'HEAD'])).trim()
  }
  const [head, upstream] = revisions
  const counts = (await git(root, ['rev-list', '--left-right', '--count', `${head}...${upstream}`]))
    .trim()
    .split(/\s+/)
  return counts[0] === '0' ? upstream : head
}

async function checkoutChanges(root: string, dir: string, git: Git): Promise<ChangedFile[]> {
  const main = await checkoutComparisonHead(root, git)
  const base = (await git(dir, ['merge-base', 'HEAD', main])).trim()
  // `--no-optional-locks` keeps the diff from rewriting the index, which an
  // agent's next turn may be using.
  const tracked = parseNumstat(
    await git(dir, ['--no-optional-locks', 'diff', '--numstat', '-z', base]),
  )
  const untrackedPaths = (await git(dir, ['ls-files', '--others', '--exclude-standard', '-z']))
    .split('\0')
    .filter(Boolean)
  const untracked = await Promise.all(untrackedPaths.map((p) => untrackedFile(dir, p)))
  return [...tracked, ...untracked.flatMap((f) => f ?? [])].sort((a, b) =>
    a.path < b.path ? -1 : 1,
  )
}

// `git diff --numstat -z`: `<added>\t<removed>\t<path>\0` per file, or for a
// rename an empty path followed by `<old>\0<new>\0`. Binary files count `-`.
function parseNumstat(out: string): ChangedFile[] {
  const fields = out.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < fields.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[i])
    if (!m) continue
    const filePath = m[3] || fields[(i += 2)]
    files.push({ path: filePath, added: count(m[1]), removed: count(m[2]) })
  }
  return files
}

const count = (n: string): number | null => (n === '-' ? null : Number(n))

// Counted the way numstat counts a new file. A nested repository lists as a
// directory and is left out.
async function untrackedFile(dir: string, file: string): Promise<ChangedFile | undefined> {
  const full = path.join(dir, file)
  const stat = await lstat(full)
  if (stat.isSymbolicLink()) return { path: file, added: 1, removed: 0 }
  if (!stat.isFile()) return undefined
  const bytes = await readFile(full)
  if (bytes.subarray(0, 8000).includes(0)) return { path: file, added: null, removed: null }
  let lines = 0
  for (const b of bytes) if (b === 0x0a) lines++
  if (bytes.length && bytes[bytes.length - 1] !== 0x0a) lines++
  return { path: file, added: lines, removed: 0 }
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
