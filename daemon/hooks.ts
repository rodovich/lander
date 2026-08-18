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
  const parts = p.split('/')
  if (parts.length !== 5) return null
  const [dot, hooks, trigger, by, file] = parts
  if (dot !== '.lander' || hooks !== 'hooks') return null
  if (!trigger || !by || !file.endsWith('.js')) return null
  const name = file.slice(0, -'.js'.length)
  if (!name) return null
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
  const r = await git(cwd, ['ls-tree', '-z', '-r', commit, '--', HOOKS_ROOT])
  // A tree with no `.lander/hooks` exits 0 with no output, so a failure here is a
  // real one (a bad commit-ish); an empty answer is indistinguishable from "no
  // hooks", which is the correct reading either way.
  return r.ok ? parseLsTree(r.stdout) : []
}

// Every blob one path has carried, most recent first, walking back from a commit.
// `git log` names the commits that touched the path; one batched `cat-file`
// resolves each to the blob the path held there. Consecutive duplicates collapse
// (a merge can list a commit that changed nothing at the path).
//
// `truncated` reports that the walk hit its limit — which is what keeps a
// "not found" answer from being cached as "never existed".
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
    `-n${limit}`,
    start,
    '--',
    hookPath,
  ])
  if (!log.ok) return { blobs: [], truncated: false }
  const commits = log.stdout.split('\n').filter(Boolean)
  if (!commits.length) return { blobs: [], truncated: false }
  const batch = await git(
    cwd,
    ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
    commits.map((c) => `${c}:${hookPath}\n`).join(''),
  )
  const blobs: string[] = []
  if (batch.ok)
    for (const line of batch.stdout.split('\n')) {
      const [object, type] = line.split(' ')
      // A `missing` line is the path not existing at that commit — the deletion
      // side of a rename, or the commit that introduced it.
      if (type !== 'blob') continue
      if (blobs[blobs.length - 1] !== object) blobs.push(object)
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

export type ResolveInput = {
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
  const { cwd } = input
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
    resolution.declared = await Promise.all(
      found.map(async (d): Promise<HookDeclaration> => {
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
      }),
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
    `${ref}^{commit}`,
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
    await Promise.all(
      paths.map(async (p) => {
        const { blobs, truncated } = await pathBlobHistory(
          git,
          cwd,
          tipCommit,
          p,
          limit,
        )
        seen.set(p, { blobs: new Set(blobs), truncated })
      }),
    )
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
