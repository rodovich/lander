// Hook resolution: what a project's tree declares under `.lander/hooks/`, and at
// which blobs. The daemon owns this because the server has no repository access
// — it maps project slugs to host paths precisely so the server can stay
// host-agnostic — and resolution is entirely `git`.
//
// The split with the server is exact: **this module answers "what does this tree
// declare, and at which blobs"; the server answers "is this pair approved".**
// Nothing here decides what may run.
//
// Two mechanics carry the design (docs/tmp/hooks.md §5):
//
//   - **Enumeration is from a commit**, never from the filesystem and never from
//     blob existence. An uncommitted edit is not rejected, it is never a
//     candidate; an object written by `git hash-object -w` or staged by `git add`
//     exists in object storage but no commit reaches it, so it is not one either.
//   - **Selection is by path** — `.lander/hooks/<trigger>/<by>/<name>.js` — so no
//     module is ever imported to discover whether it applies. Importing is
//     executing, and it must not precede an approval check.

import { execFile } from 'node:child_process'
import type {
  HookDeclaration,
  HookPair,
  HookSelector,
  HooksResolution,
} from '../server/protocol'

export type GitResult = { ok: boolean; stdout: string; stderr: string }

// A git invocation, injected so this module is testable against a fake and the
// real one is a single implementation detail below.
export type GitExec = (
  cwd: string,
  args: string[],
  input?: string,
) => Promise<GitResult>

// The only directory hooks are read from. A literal: the selectors below filter
// `ls-tree` output rather than naming a directory to list, so no caller-supplied
// string ever reaches an argv as a path.
export const HOOKS_ROOT = '.lander/hooks'

// How far back to look for a path's earlier versions (the approval fallback) and
// for a version that has since moved on from the trust root's tip. Both bounded:
// an unbounded walk over a long history is a sweep-stalling subprocess, and both
// answers are useful truncated as long as the truncation is reported.
const DEFAULT_ANCESTRY_LIMIT = 25
const DEFAULT_TRUST_ROOT_LIMIT = 250

// A remote-tracking ref, as a human designated it. Validated before it reaches an
// argv: it is the one string in a resolve request that did not come out of the
// repository itself. Leading `-` is excluded so a ref can never be read as a flag.
const REF_SAFE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

export function isSafeRef(ref: string): boolean {
  return REF_SAFE.test(ref) && !ref.includes('..')
}

// The full ref a designated trust root resolves to — always under
// `refs/remotes/`, never whatever git's lookup order happens to prefer.
//
// Both halves of that are load-bearing. Git resolves a bare name by checking
// `refs/heads/` BEFORE `refs/remotes/`, so a local branch literally named
// `origin/main` shadows the remote-tracking ref of the same name — and creating
// one is a typo-grade command, not the deliberate `update-ref` forgery the design
// accepts as out of scope (docs/tmp/hooks.md §5). Qualifying here also means a
// human who types `main` designates `refs/remotes/main`, which almost never
// exists, rather than the local branch any agent that can merge could advance:
// the remote-tracking requirement stops being a comment and becomes the lookup.
export function trustRootRef(ref: string): string {
  const bare = ref.replace(/^refs\/remotes\//, '')
  return `refs/remotes/${bare}`
}

export const gitExec: GitExec = (cwd, args, input) =>
  new Promise((resolve) => {
    const child = execFile(
      'git',
      ['-C', cwd, ...args],
      // Large enough for a hooks-directory listing and a bounded rev-list; git
      // exceeding it fails the call rather than truncating the answer.
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) =>
        resolve({
          ok: !err,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        }),
    )
    // Always closed, including when there is no input: `cat-file --batch-check`
    // reads until EOF, and an open stdin would hang it forever.
    child.stdin?.end(input ?? '')
  })

// `.lander/hooks/<trigger>/<by>/<name>.js`, exactly. A deeper path, a file that
// is not `.js`, a stemless name — none of those is a hook. They are not rejected
// at run time; they are simply never candidates, which is the same treatment an
// uncommitted file gets.
export function parseHookPath(
  p: string,
): { trigger: string; by: string; name: string } | null {
  // A newline would split a `cat-file --batch-check` input line in two; `-z`
  // parsing means such a path can actually reach here.
  if (p.includes('\n')) return null
  const parts = p.split('/')
  if (parts.length !== 5) return null
  const [dot, hooks, trigger, by, file] = parts
  if (dot !== '.lander' || hooks !== 'hooks') return null
  if (!trigger || !by || !file.endsWith('.js')) return null
  // `.` and `..` are legal characters-wise but name a directory rather than a
  // trigger or a principal, and the server mirrors this grammar to key its
  // store.
  if ([trigger, by].some((s) => s === '.' || s === '..')) return null
  const name = file.slice(0, -'.js'.length)
  if (!name || name === '.' || name === '..') return null
  return { trigger, by, name }
}

export type TreeEntry = {
  mode: string
  type: string
  object: string
  path: string
}

// `ls-tree -z` output: `<mode> SP <type> SP <object> TAB <path>` per NUL-separated
// record. `-z` rather than the default so a path with a quote, a backslash or a
// newline arrives verbatim instead of C-quoted.
export function parseLsTree(out: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const record of out.split('\0')) {
    if (!record) continue
    const tab = record.indexOf('\t')
    if (tab < 0) continue
    const head = record.slice(0, tab).split(' ')
    if (head.length < 3) continue
    entries.push({
      mode: head[0],
      type: head[1],
      object: head[2],
      path: record.slice(tab + 1),
    })
  }
  return entries
}

function matchesSelector(
  d: { trigger: string; by: string },
  select?: HookSelector[],
): boolean {
  if (!select?.length) return true
  return select.some(
    (s) =>
      (!s.trigger || s.trigger === d.trigger) && (!s.by || s.by === d.by),
  )
}

// The hook declarations in a tree listing. `mode` is checked, not just `type`: a
// symlink is also a blob, and its content is a path rather than a module — so a
// symlinked hook would materialize as a text file naming a target nobody
// approved. Only regular files (100644/100755) are candidates.
export function hookEntries(
  entries: TreeEntry[],
  select?: HookSelector[],
): { path: string; blob: string; trigger: string; by: string; name: string }[] {
  const out: ReturnType<typeof hookEntries> = []
  for (const e of entries) {
    if (e.type !== 'blob' || !e.mode.startsWith('100')) continue
    const parsed = parseHookPath(e.path)
    if (!parsed || !matchesSelector(parsed, select)) continue
    out.push({ path: e.path, blob: e.object, ...parsed })
  }
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

async function lsHooks(
  git: GitExec,
  cwd: string,
  commit: string,
): Promise<TreeEntry[]> {
  // `--full-tree` because a pathspec is resolved relative to the PROCESS cwd, not
  // the repository root, and the cwd here is wherever the target task works — for
  // Codex, the directory its last turn ended in, which `POST /tasks/:id/cwd`
  // explicitly permits to be a subdirectory. Without it, `.lander/hooks` names
  // `<subdir>/.lander/hooks`, every project resolves to zero hooks from a
  // subdirectory, and the answer is indistinguishable from "declares none".
  // It also makes the reported paths repository-root-relative, which is what
  // parseHookPath and the approval store are keyed on.
  const r = await git(cwd, [
    'ls-tree',
    '--full-tree',
    '-z',
    '-r',
    commit,
    '--',
    HOOKS_ROOT,
  ])
  // A tree with no `.lander/hooks` exits 0 with no output, so a failure here is a
  // real one (a bad commit-ish); an empty answer is indistinguishable from "no
  // hooks", which is the correct reading either way.
  return r.ok ? parseLsTree(r.stdout) : []
}

// Every blob one path has carried, most recent first, walking back from a commit.
// `git log` names the commits that touched the path; one batched `cat-file`
// resolves each to the blob the path held there, and each blob is kept at its
// first (most recent) appearance.
//
// `--full-history` because default history simplification follows ONE parent
// through a merge, so a version that is genuinely reachable from the enumerated
// commit can be missing from the walk — verified: a version committed on the
// mainline and then superseded by a merge taking the other side's file does not
// appear without it. That would break both promises this function serves: the
// fallback would skip an approved version and report the hook as unrunnable, and
// the trust-root scan would demand approval for a version that did reach the
// branch. `--topo-order` because "most recent" must mean ancestry, not a commit
// date an author can set to anything.
//
// `:(top)` anchors the pathspec at the repository root for the same reason
// `lsHooks` passes `--full-tree` — the cwd may be a subdirectory of it.
//
// `truncated` means "absence is not proven here", and covers both the walk
// hitting its limit and git failing to answer at all. Its whole job is to keep a
// "not found" from being cached as "never existed", so a failure has to take the
// same branch as a limit; reporting a git error as an exhaustive empty history is
// how a transient failure becomes a permanent wrong answer.
async function pathBlobHistory(
  git: GitExec,
  cwd: string,
  start: string,
  hookPath: string,
  limit: number,
): Promise<{ blobs: string[]; truncated: boolean }> {
  const log = await git(cwd, [
    'log',
    '--format=%H',
    '--full-history',
    '--topo-order',
    `-n${limit}`,
    start,
    '--',
    `:(top)${hookPath}`,
  ])
  if (!log.ok) return { blobs: [], truncated: true }
  const commits = log.stdout.split('\n').filter(Boolean)
  if (!commits.length) return { blobs: [], truncated: false }
  const batch = await git(
    cwd,
    ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
    commits.map((c) => `${c}:${hookPath}\n`).join(''),
  )
  if (!batch.ok) return { blobs: [], truncated: true }
  const seen = new Set<string>()
  const blobs: string[] = []
  for (const line of batch.stdout.split('\n')) {
    const [object, type] = line.split(' ')
    // A `missing` line is the path not existing at that commit — the deletion
    // side of a rename, or the commit that introduced it.
    if (type !== 'blob' || seen.has(object)) continue
    seen.add(object)
    blobs.push(object)
  }
  return { blobs, truncated: commits.length >= limit }
}

async function headCommit(
  git: GitExec,
  cwd: string,
): Promise<{ commit?: string; reason?: string }> {
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  const commit = head.stdout.trim()
  if (head.ok && commit) return { commit }
  const repo = await git(cwd, ['rev-parse', '--git-dir'])
  // "A project that is not a git repository has no hooks" — and neither has one
  // whose HEAD has no commit yet, for the same reason: nothing is reachable.
  return { reason: repo.ok ? 'unborn-head' : 'not-a-repo' }
}

// How many paths are walked at once. Each walk spawns two `git` children, and
// this runs in the process that owns every in-flight run — an uncapped fan-out
// over a project with many hooks would put hundreds of children against it at
// once, and increment B moves this onto the 15-second scheduler sweep.
const WALK_CONCURRENCY = 4

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i])
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  )
  return out
}

// Whether two directories are the same repository, by the object store they
// share. A linked worktree answers with its parent's common dir, which is exactly
// the identity wanted: a worktree of the project IS the project's repository, and
// a nested `git init` under the project root is not.
async function sameRepository(
  git: GitExec,
  a: string,
  b: string,
): Promise<boolean> {
  const [ra, rb] = await Promise.all([
    git(a, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    git(b, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
  ])
  return ra.ok && rb.ok && !!ra.stdout.trim() && ra.stdout.trim() === rb.stdout.trim()
}

export type ResolveInput = {
  // The project's own root. Both the fallback when the target's checkout is
  // unusable and the identity every read is checked against.
  root: string
  // The checkout to read — a task's worktree when it has one, the project root
  // otherwise. Resolved by the caller, which owns the host paths.
  cwd: string
  // The remote-tracking ref whose contents the project approves wholesale, when
  // it designates one.
  trustRoot?: string
  // Enumerate the tree (and, with a trust root, that ref's tip). Absent when the
  // caller wants only a history scan.
  declare?: { select?: HookSelector[]; ancestryLimit?: number }
  // Look for these pairs anywhere in the trust root's history — the second phase,
  // for declared pairs the caller could answer from neither the tip nor its own
  // store.
  history?: { pairs: HookPair[]; limit?: number }
}

export async function resolveHooks(
  git: GitExec,
  input: ResolveInput,
): Promise<HooksResolution> {
  // Read the target's checkout only once it is established to be the project's
  // own repository. The two cwd hints are both task-writable — `POST
  // /tasks/:id/cwd` takes any directory under the project root, and the worktree
  // name is validated for shape rather than existence — so without this a task
  // could `git init` a scratch repository, commit hooks and a
  // `refs/remotes/origin/main` into it, point its own cwd there, and have the
  // server cache that repository's pairs into THIS project's approval store.
  // Blobs are content-addressed, so the same bytes at the same path in the real
  // repository would then already be approved.
  //
  // The benign case matters as much: a vendored dependency or a submodule under
  // a task's cwd would otherwise mix another repository's hooks into this
  // project's. Falling back to the project root answers with the project's own
  // hooks, which is the honest degradation; `cwd` in the response reports which
  // directory was actually read.
  const cwd =
    input.cwd === input.root || (await sameRepository(git, input.cwd, input.root))
      ? input.cwd
      : input.root
  const { commit, reason } = await headCommit(git, cwd)
  const resolution: HooksResolution = { cwd }
  if (commit) resolution.commit = commit
  if (reason) resolution.reason = reason
  if (reason === 'not-a-repo') return resolution

  if (input.declare && commit) {
    const ancestryLimit = input.declare.ancestryLimit ?? DEFAULT_ANCESTRY_LIMIT
    const found = hookEntries(
      await lsHooks(git, cwd, commit),
      input.declare.select,
    )
    resolution.declared = await mapLimit(
      found,
      WALK_CONCURRENCY,
      async (d): Promise<HookDeclaration> => {
        const { blobs, truncated } = await pathBlobHistory(
          git,
          cwd,
          commit,
          d.path,
          ancestryLimit,
        )
        return {
          ...d,
          // The declared blob is the primary candidate, so it is never also a
          // fallback candidate — dropped wherever it appears, including a path
          // that was reverted to an earlier version.
          ancestry: blobs.filter((b) => b !== d.blob),
          ...(truncated ? { ancestryTruncated: true } : {}),
        }
      },
    )
  } else if (input.declare) {
    resolution.declared = []
  }

  const ref = input.trustRoot
  if (!ref) return resolution
  if (!isSafeRef(ref)) {
    resolution.trustRoot = { ref, reason: 'invalid-ref' }
    return resolution
  }
  const tipRev = await git(cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${trustRootRef(ref)}^{commit}`,
  ])
  const tipCommit = tipRev.stdout.trim()
  if (!tipRev.ok || !tipCommit) {
    // The designated ref does not exist here — an unfetched clone, a renamed
    // default branch, a project with no remote. Reported rather than treated as
    // "nothing is approved", because the two are not the same fact.
    resolution.trustRoot = { ref, reason: 'unresolved-ref' }
    return resolution
  }
  const trustRoot: NonNullable<HooksResolution['trustRoot']> = {
    ref,
    commit: tipCommit,
  }
  if (input.declare)
    trustRoot.tip = hookEntries(await lsHooks(git, cwd, tipCommit)).map(
      ({ path, blob }) => ({ path, blob }),
    )
  if (input.history?.pairs.length) {
    const limit = input.history.limit ?? DEFAULT_TRUST_ROOT_LIMIT
    const paths = [...new Set(input.history.pairs.map((p) => p.path))]
    const seen = new Map<string, { blobs: Set<string>; truncated: boolean }>()
    await mapLimit(paths, WALK_CONCURRENCY, async (p) => {
      const { blobs, truncated } = await pathBlobHistory(
        git,
        cwd,
        tipCommit,
        p,
        limit,
      )
      seen.set(p, { blobs: new Set(blobs), truncated })
    })
    trustRoot.found = input.history.pairs.filter((pair) =>
      seen.get(pair.path)?.blobs.has(pair.blob),
    )
    // Which paths could not be answered exhaustively, so a miss on one is "not
    // found within `limit` commits" rather than "never on the trust root".
    const truncated = paths.filter((p) => seen.get(p)?.truncated)
    if (truncated.length) trustRoot.historyTruncated = truncated
  }
  resolution.trustRoot = trustRoot
  return resolution
}
