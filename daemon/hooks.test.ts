// Hook resolution, against a real repository. The mechanic under test is
// reachability: what a commit reaches is a candidate and nothing else is — not a
// working-tree edit, not a staged file, not a bare object. A fake git could only
// re-assert the parsing, so these drive the real one.

import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  gitExec,
  hookEntries,
  isSafeRef,
  parseHookPath,
  parseLsTree,
  resolveHooks,
  trustRootRef,
  type GitExec,
  type ResolveInput,
} from './hooks'

// Isolated from the developer's own git config: a global `commit.gpgsign`, a
// template dir, or an `init.defaultBranch` would otherwise leak into the fixture.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

async function writeHook(
  repo: string,
  rel: string,
  body: string,
): Promise<void> {
  const file = path.join(repo, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, body)
}

describe('parseHookPath', () => {
  it('accepts exactly .lander/hooks/<trigger>/<by>/<name>.js', () => {
    expect(parseHookPath('.lander/hooks/landed/agent/verify.js')).toEqual({
      trigger: 'landed',
      by: 'agent',
      name: 'verify',
    })
  })

  // Every rejection here is a path that must never become a candidate — not
  // "rejected at run time", never selected at all, since selection is what
  // happens before an approval check.
  it.each([
    ['.lander/hooks/landed/any/cleanup.md', 'not a module'],
    ['.lander/hooks/landed/any/nested/deep.js', 'a directory too deep'],
    ['.lander/hooks/landed/cleanup.js', 'no principal level'],
    ['.lander/hooks/landed/any/.js', 'no name'],
    ['.lander/hooks/README.md', 'a doc in the hooks root'],
    ['lander/hooks/landed/any/cleanup.js', 'outside .lander'],
    ['.lander/flows/landed/any/cleanup.js', 'a different .lander subtree'],
  ])('rejects %s (%s)', (p) => {
    expect(parseHookPath(p)).toBeNull()
  })
})

describe('parseLsTree', () => {
  it('reads NUL-separated records with tabs and spaces in the path', () => {
    const out =
      '100644 blob aaa\t.lander/hooks/landed/any/a b.js\0' +
      '040000 tree bbb\t.lander/hooks/landed\0'
    expect(parseLsTree(out)).toEqual([
      {
        mode: '100644',
        type: 'blob',
        object: 'aaa',
        path: '.lander/hooks/landed/any/a b.js',
      },
      { mode: '040000', type: 'tree', object: 'bbb', path: '.lander/hooks/landed' },
    ])
  })
})

describe('hookEntries', () => {
  const entries = [
    {
      mode: '100644',
      type: 'blob',
      object: 'a1',
      path: '.lander/hooks/landed/any/cleanup.js',
    },
    {
      mode: '100755',
      type: 'blob',
      object: 'a2',
      path: '.lander/hooks/landed/agent/verify.js',
    },
    {
      mode: '100644',
      type: 'blob',
      object: 'a3',
      path: '.lander/hooks/ride-ended/any/supervise.js',
    },
  ]

  it('selects by trigger and principal, and `any` is just another directory', () => {
    const picked = hookEntries(entries, [
      { trigger: 'landed', by: 'agent' },
      { trigger: 'landed', by: 'any' },
    ])
    expect(picked.map((d) => d.name)).toEqual(['verify', 'cleanup'])
  })

  it('takes everything when nothing is selected', () => {
    expect(hookEntries(entries)).toHaveLength(3)
  })

  // A symlink is a blob too, and its content is a path rather than a module — so
  // an approved-looking symlink would materialize as a file naming a target
  // nobody reviewed.
  it('ignores a symlink', () => {
    expect(
      hookEntries([
        {
          mode: '120000',
          type: 'blob',
          object: 'l1',
          path: '.lander/hooks/landed/any/link.js',
        },
      ]),
    ).toEqual([])
  })
})

describe('isSafeRef', () => {
  it.each(['origin/main', 'refs/remotes/origin/release-2.x', 'upstream/main'])(
    'accepts %s',
    (ref) => expect(isSafeRef(ref)).toBe(true),
  )
  it.each(['--upload-pack=evil', '-x', 'origin/../HEAD', 'origin main', ''])(
    'rejects %s',
    (ref) => expect(isSafeRef(ref)).toBe(false),
  )
})

describe('resolveHooks', () => {
  let repo: string
  let firstCommit: string
  let firstBlob: string
  let secondBlob: string
  let thirdBlob: string

  // Every resolution is checked against the project root, so the tests name it
  // explicitly rather than letting `cwd` stand in for both.
  const resolve = (input: Omit<ResolveInput, 'root'> & { root?: string }) =>
    resolveHooks(gitExec, { root: repo, ...input })

  beforeAll(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'lander-hooks-repo-'))
    git(repo, 'init', '-b', 'main')
    await writeHook(repo, '.lander/hooks/landed/any/cleanup.js', 'export const v = 1\n')
    await writeHook(repo, '.lander/hooks/landed/agent/verify.js', 'export const v = 1\n')
    await writeHook(
      repo,
      '.lander/hooks/ride-ended/any/supervise.js',
      'export const v = 1\n',
    )
    // Not a hook by path, so it must never be enumerated even though it is
    // committed right beside them.
    await writeHook(repo, '.lander/hooks/README.md', 'docs\n')
    await writeHook(repo, '.lander/hooks/landed/any/lib/helper.js', 'export const h = 1\n')
    // A subdirectory, so a resolution can be asked for from inside one.
    await mkdir(path.join(repo, 'sub'), { recursive: true })
    await writeFile(path.join(repo, 'sub', 'a.txt'), 'a\n')
    git(repo, 'add', '.lander', 'sub')
    git(repo, 'commit', '-m', 'first')
    firstCommit = git(repo, 'rev-parse', 'HEAD')
    firstBlob = git(repo, 'rev-parse', 'HEAD:.lander/hooks/landed/any/cleanup.js')

    await writeHook(repo, '.lander/hooks/landed/any/cleanup.js', 'export const v = 2\n')
    git(repo, 'add', '.lander')
    git(repo, 'commit', '-m', 'second')
    secondBlob = git(repo, 'rev-parse', 'HEAD:.lander/hooks/landed/any/cleanup.js')

    await writeHook(repo, '.lander/hooks/landed/any/cleanup.js', 'export const v = 3\n')
    git(repo, 'add', '.lander')
    git(repo, 'commit', '-m', 'third')
    thirdBlob = git(repo, 'rev-parse', 'HEAD:.lander/hooks/landed/any/cleanup.js')
  })

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('lists what the commit reaches, with the blob it reaches it at', async () => {
    const r = await resolve({ cwd: repo, declare: {} })
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(r.declared?.map((d) => [d.trigger, d.by, d.name])).toEqual([
      ['landed', 'agent', 'verify'],
      ['landed', 'any', 'cleanup'],
      ['ride-ended', 'any', 'supervise'],
    ])
    expect(
      r.declared?.find((d) => d.name === 'cleanup')?.blob,
    ).toBe(thirdBlob)
  })

  // Three versions, so the order is a real assertion: a one-element ancestry is
  // order-blind, and the fallback takes the FIRST approved entry it finds.
  it('reports the earlier versions of a path, most recent first', async () => {
    const r = await resolve({ cwd: repo, declare: {} })
    const cleanup = r.declared?.find((d) => d.name === 'cleanup')
    expect(cleanup?.ancestry).toEqual([secondBlob, firstBlob])
    // A hook introduced in one commit and never changed has no fallback at all.
    expect(r.declared?.find((d) => d.name === 'verify')?.ancestry).toEqual([])
  })

  it('selects by trigger and principal', async () => {
    const r = await resolve({
      cwd: repo,
      declare: { select: [{ trigger: 'ride-ended' }] },
    })
    expect(r.declared?.map((d) => d.name)).toEqual(['supervise'])
  })

  // A pathspec is resolved relative to the PROCESS cwd, not the repository root,
  // and a Codex task's recorded cwd is wherever its last turn ended — which
  // POST /tasks/:id/cwd explicitly allows to be a subdirectory. Without
  // --full-tree and :(top) this answers "declares no hooks" for every such task,
  // silently and only under one provider.
  it('answers identically from a subdirectory of the checkout', async () => {
    const fromRoot = await resolve({ cwd: repo, declare: {} })
    const fromSub = await resolve({ cwd: path.join(repo, 'sub'), declare: {} })
    expect(fromSub.declared).toEqual(fromRoot.declared)
    expect(fromSub.declared?.length).toBeGreaterThan(0)
    // Root-relative, because that is what the approval store is keyed on.
    expect(fromSub.declared?.[0].path.startsWith('.lander/')).toBe(true)
  })

  // T1: the working tree is never a source of hook code.
  it('does not see an uncommitted edit, and keeps resolving the committed blob', async () => {
    await writeHook(
      repo,
      '.lander/hooks/landed/any/cleanup.js',
      'export const v = 3 // uncommitted\n',
    )
    const r = await resolve({ cwd: repo, declare: {} })
    expect(r.declared?.find((d) => d.name === 'cleanup')?.blob).toBe(thirdBlob)
    await writeHook(repo, '.lander/hooks/landed/any/cleanup.js', 'export const v = 3\n')
  })

  // T1, the other half: a brand-new file the tree has never carried.
  it('does not see an uncommitted new hook', async () => {
    await writeHook(repo, '.lander/hooks/landed/any/rogue.js', 'export const v = 1\n')
    const r = await resolve({ cwd: repo, declare: {} })
    expect(r.declared?.map((d) => d.name)).not.toContain('rogue')
    await rm(path.join(repo, '.lander/hooks/landed/any/rogue.js'))
  })

  // T2: blob existence is not the test. Both of these put an object in storage
  // that no commit reaches.
  it('does not see a `git hash-object -w` blob or a staged file', async () => {
    await writeHook(repo, '.lander/hooks/landed/any/staged.js', 'export const v = 1\n')
    git(repo, 'hash-object', '-w', '.lander/hooks/landed/any/staged.js')
    git(repo, 'add', '.lander/hooks/landed/any/staged.js')
    const r = await resolve({ cwd: repo, declare: {} })
    expect(r.declared?.map((d) => d.name)).not.toContain('staged')
    git(repo, 'rm', '-f', '--cached', '.lander/hooks/landed/any/staged.js')
    await rm(path.join(repo, '.lander/hooks/landed/any/staged.js'))
  })

  it('does not see a module nested below the principal directory', async () => {
    const r = await resolve({ cwd: repo, declare: {} })
    expect(r.declared?.map((d) => d.path)).not.toContain(
      '.lander/hooks/landed/any/lib/helper.js',
    )
  })

  it('does not see a committed symlink', async () => {
    const link = path.join(repo, '.lander/hooks/landed/any/link.js')
    await symlink('cleanup.js', link)
    git(repo, 'add', '.lander/hooks/landed/any/link.js')
    git(repo, 'commit', '-m', 'symlink')
    try {
      const r = await resolve({ cwd: repo, declare: {} })
      expect(r.declared?.map((d) => d.name)).not.toContain('link')
    } finally {
      git(repo, 'rm', '-f', '.lander/hooks/landed/any/link.js')
      git(repo, 'commit', '-m', 'drop symlink')
    }
  })

  describe('trust root', () => {
    beforeAll(() => {
      // A remote-tracking ref without a remote: `refs/remotes/origin/main` is an
      // ordinary local ref, which is both what makes this fixture cheap and the
      // exposure §5 of the design accepts. Pinned to the first commit by sha
      // rather than by `HEAD~n`, so a test that adds a commit above cannot move
      // what "upstream" means here.
      git(repo, 'update-ref', 'refs/remotes/origin/main', firstCommit)
    })

    it('reports the ref, its commit, and the pairs at its tip', async () => {
      const r = await resolve({
        cwd: repo,
        trustRoot: 'origin/main',
        declare: {},
      })
      expect(r.trustRoot?.commit).toMatch(/^[0-9a-f]{40}$/)
      // The tip is one commit back, so it carries the FIRST version of cleanup —
      // which is the case that makes the tip alone insufficient.
      expect(r.trustRoot?.tip).toContainEqual({
        path: '.lander/hooks/landed/any/cleanup.js',
        blob: firstBlob,
      })
      expect(r.trustRoot?.tip).not.toContainEqual({
        path: '.lander/hooks/landed/any/cleanup.js',
        blob: secondBlob,
      })
    })

    it('finds a version that has since moved on from the tip', async () => {
      const r = await resolve({
        cwd: repo,
        trustRoot: 'origin/main',
        history: {
          pairs: [
            // On the trust root, though no longer at its tip.
            { path: '.lander/hooks/landed/any/cleanup.js', blob: firstBlob },
            // Never on it: this is the version only the local branch carries.
            { path: '.lander/hooks/landed/any/cleanup.js', blob: secondBlob },
          ],
        },
      })
      expect(r.trustRoot?.found).toEqual([
        { path: '.lander/hooks/landed/any/cleanup.js', blob: firstBlob },
      ])
    })

    it('reports a truncated scan rather than letting a miss look conclusive', async () => {
      const r = await resolve({
        cwd: repo,
        trustRoot: 'origin/main',
        history: {
          pairs: [{ path: '.lander/hooks/landed/any/cleanup.js', blob: secondBlob }],
          limit: 1,
        },
      })
      expect(r.trustRoot?.found).toEqual([])
      expect(r.trustRoot?.historyTruncated).toEqual([
        '.lander/hooks/landed/any/cleanup.js',
      ])
    })

    // Git resolves a bare name through refs/heads/ BEFORE refs/remotes/, so a
    // local branch of the same name wins an unqualified lookup. `git branch
    // origin/main` is a typo-grade command — not the deliberate `update-ref`
    // forgery §5 accepts as out of scope — and it would otherwise let any agent
    // that can commit put a blob on the "trust root".
    it('is not shadowed by a local branch of the same name', async () => {
      git(repo, 'branch', 'origin/main', 'HEAD')
      try {
        const r = await resolve({ cwd: repo, trustRoot: 'origin/main', declare: {} })
        expect(r.trustRoot?.commit).toBe(firstCommit)
        expect(r.trustRoot?.commit).not.toBe(git(repo, 'rev-parse', 'HEAD'))
      } finally {
        git(repo, 'branch', '-D', 'origin/main')
      }
    })

    // The remote-tracking requirement is the whole reason the trust root is not
    // local `main`: advancing a remote-tracking ref takes a push. Resolving every
    // designation under refs/remotes/ makes that structural rather than advisory.
    it('does not resolve a local branch, however it is spelled', async () => {
      for (const ref of ['main', 'refs/heads/main']) {
        const r = await resolve({ cwd: repo, trustRoot: ref, declare: {} })
        expect(r.trustRoot?.commit).toBeUndefined()
      }
    })

    it('reports a ref that does not resolve here', async () => {
      const r = await resolve({
        cwd: repo,
        trustRoot: 'origin/nonexistent',
        declare: {},
      })
      expect(r.trustRoot).toEqual({ ref: 'origin/nonexistent', reason: 'unresolved-ref' })
      // The tree still resolves — a missing trust root is not a failure to answer.
      expect(r.declared?.length).toBeGreaterThan(0)
    })

    it('refuses a ref that could be read as a flag', async () => {
      const r = await resolve({
        cwd: repo,
        trustRoot: '--upload-pack=touch /tmp/pwned',
        declare: {},
      })
      expect(r.trustRoot?.reason).toBe('invalid-ref')
      expect(r.trustRoot?.commit).toBeUndefined()
    })
  })
})

// Default `git log` simplification follows one parent through a merge, so a
// version genuinely reachable from the enumerated commit can be missing from the
// walk. Both promises resolution makes depend on the walk being complete: the
// fallback would skip an approved version and report the hook unrunnable, and the
// trust-root scan would demand approval for a version that did reach the branch.
describe('resolveHooks across a merge', () => {
  it('sees a version a merge superseded but did not remove from history', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'lander-hooks-merge-'))
    try {
      git(repo, 'init', '-b', 'main')
      const hook = '.lander/hooks/landed/any/x.js'
      await writeHook(repo, hook, 'v1\n')
      git(repo, 'add', '.lander')
      git(repo, 'commit', '-m', 'v1')
      const base = git(repo, 'rev-parse', 'HEAD')

      git(repo, 'checkout', '-q', '-b', 'side', base)
      await writeHook(repo, hook, 'v2-side\n')
      git(repo, 'add', '.lander')
      git(repo, 'commit', '-m', 'v2 on side')

      git(repo, 'checkout', '-q', 'main')
      await writeHook(repo, hook, 'v3-main\n')
      git(repo, 'add', '.lander')
      git(repo, 'commit', '-m', 'v3 on main')
      const v3 = git(repo, 'rev-parse', `HEAD:${hook}`)

      // Resolved in the side branch's favor, so the merge's tree does not carry
      // v3 — but v3 is still an ancestor, and a human who approved it expects it
      // to keep running rather than to vanish.
      git(repo, 'merge', '-q', '--no-edit', '-X', 'theirs', 'side')

      const r = await resolveHooks(gitExec, { root: repo, cwd: repo, declare: {} })
      expect(r.declared?.[0].ancestry).toContain(v3)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

// Both cwd hints are task-writable — POST /tasks/:id/cwd takes any directory
// under the project root, and a worktree name is validated for shape rather than
// existence — so "under the project root" does not make a directory the
// project's tree. Reading one would let a task stand up its own repository, with
// its own refs/remotes/origin/main, and have its pairs cached into this
// project's approval store; blobs are content-addressed, so the same bytes at
// the same path in the real repository would then already be approved.
describe('resolveHooks against a foreign checkout', () => {
  it('falls back to the project root for a repository that is not the project’s', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lander-hooks-root-'))
    try {
      git(root, 'init', '-b', 'main')
      await writeHook(root, '.lander/hooks/landed/any/real.js', 'real\n')
      git(root, 'add', '.lander')
      git(root, 'commit', '-m', 'real')

      const nested = path.join(root, 'scratch')
      await mkdir(nested, { recursive: true })
      git(nested, 'init', '-b', 'main')
      await writeHook(nested, '.lander/hooks/landed/any/evil.js', 'evil\n')
      git(nested, 'add', '.lander')
      git(nested, 'commit', '-m', 'evil')
      git(nested, 'update-ref', 'refs/remotes/origin/main', 'HEAD')

      const r = await resolveHooks(gitExec, {
        root,
        cwd: nested,
        trustRoot: 'origin/main',
        declare: {},
      })
      expect(r.cwd).toBe(root)
      expect(r.declared?.map((d) => d.name)).toEqual(['real'])
      // And nothing from that repository's trust root is offered for caching.
      expect(r.trustRoot?.tip ?? []).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads a linked worktree, which shares the project’s object store', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lander-hooks-wt-'))
    const tree = path.join(root, 'wt')
    try {
      git(root, 'init', '-b', 'main')
      await writeHook(root, '.lander/hooks/landed/any/real.js', 'real\n')
      git(root, 'add', '.lander')
      git(root, 'commit', '-m', 'real')
      git(root, 'worktree', 'add', '-q', tree, '-b', 'feature')

      const r = await resolveHooks(gitExec, { root, cwd: tree, declare: {} })
      expect(r.cwd).toBe(tree)
      expect(r.declared?.map((d) => d.name)).toEqual(['real'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// `truncated` is the one channel for "absence is not proven here", and its whole
// job is to stop a miss being cached as "never existed". A git that fails has to
// take the same branch as a walk that hit its limit, or a transient failure
// becomes a permanent wrong answer.
describe('resolveHooks when git fails', () => {
  it('reports an unprovable absence rather than an exhaustive empty history', async () => {
    const real = gitExec
    const failingLog: GitExec = (cwd, args, input) =>
      args[0] === 'log'
        ? Promise.resolve({ ok: false, stdout: '', stderr: 'fatal: bad object' })
        : real(cwd, args, input)
    const repo = await mkdtemp(path.join(tmpdir(), 'lander-hooks-failing-'))
    try {
      git(repo, 'init', '-b', 'main')
      await writeHook(repo, '.lander/hooks/landed/any/x.js', 'v1\n')
      git(repo, 'add', '.lander')
      git(repo, 'commit', '-m', 'v1')

      const r = await resolveHooks(failingLog, { root: repo, cwd: repo, declare: {} })
      expect(r.declared?.[0].ancestry).toEqual([])
      expect(r.declared?.[0].ancestryTruncated).toBe(true)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe('trustRootRef', () => {
  it('qualifies every designation under refs/remotes/, idempotently', () => {
    expect(trustRootRef('origin/main')).toBe('refs/remotes/origin/main')
    expect(trustRootRef('refs/remotes/origin/main')).toBe('refs/remotes/origin/main')
    // The point of the qualification: a local branch cannot be named this way.
    expect(trustRootRef('main')).toBe('refs/remotes/main')
  })
})

describe('resolveHooks outside a repository', () => {
  it('says so, and declares nothing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lander-hooks-bare-'))
    try {
      const r = await resolveHooks(gitExec, { root: dir, cwd: dir, declare: {} })
      expect(r.reason).toBe('not-a-repo')
      expect(r.commit).toBeUndefined()
      expect(r.declared).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('distinguishes an unborn HEAD from no repository at all', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lander-hooks-unborn-'))
    try {
      git(dir, 'init', '-b', 'main')
      const r = await resolveHooks(gitExec, { root: dir, cwd: dir, declare: {} })
      expect(r.reason).toBe('unborn-head')
      expect(r.declared).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
