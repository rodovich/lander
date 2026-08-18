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
    git(repo, 'add', '.lander')
    git(repo, 'commit', '-m', 'first')
    firstCommit = git(repo, 'rev-parse', 'HEAD')
    firstBlob = git(repo, 'rev-parse', 'HEAD:.lander/hooks/landed/any/cleanup.js')

    await writeHook(repo, '.lander/hooks/landed/any/cleanup.js', 'export const v = 2\n')
    git(repo, 'add', '.lander')
    git(repo, 'commit', '-m', 'second')
    secondBlob = git(repo, 'rev-parse', 'HEAD:.lander/hooks/landed/any/cleanup.js')
  })

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true })
  })

  it('lists what the commit reaches, with the blob it reaches it at', async () => {
    const r = await resolveHooks(gitExec, { cwd: repo, declare: {} })
    expect(r.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(r.declared?.map((d) => [d.trigger, d.by, d.name])).toEqual([
      ['landed', 'agent', 'verify'],
      ['landed', 'any', 'cleanup'],
      ['ride-ended', 'any', 'supervise'],
    ])
    expect(
      r.declared?.find((d) => d.name === 'cleanup')?.blob,
    ).toBe(secondBlob)
  })

  it('reports the earlier versions of a path, most recent first', async () => {
    const r = await resolveHooks(gitExec, { cwd: repo, declare: {} })
    const cleanup = r.declared?.find((d) => d.name === 'cleanup')
    expect(cleanup?.ancestry).toEqual([firstBlob])
    // A hook introduced in one commit and never changed has no fallback at all.
    expect(r.declared?.find((d) => d.name === 'verify')?.ancestry).toEqual([])
  })

  it('selects by trigger and principal', async () => {
    const r = await resolveHooks(gitExec, {
      cwd: repo,
      declare: { select: [{ trigger: 'ride-ended' }] },
    })
    expect(r.declared?.map((d) => d.name)).toEqual(['supervise'])
  })

  // T1: the working tree is never a source of hook code.
  it('does not see an uncommitted edit, and keeps resolving the committed blob', async () => {
    await writeHook(
      repo,
      '.lander/hooks/landed/any/cleanup.js',
      'export const v = 3 // uncommitted\n',
    )
    const r = await resolveHooks(gitExec, { cwd: repo, declare: {} })
    expect(r.declared?.find((d) => d.name === 'cleanup')?.blob).toBe(secondBlob)
    await writeHook(repo, '.lander/hooks/landed/any/cleanup.js', 'export const v = 2\n')
  })

  // T1, the other half: a brand-new file the tree has never carried.
  it('does not see an uncommitted new hook', async () => {
    await writeHook(repo, '.lander/hooks/landed/any/rogue.js', 'export const v = 1\n')
    const r = await resolveHooks(gitExec, { cwd: repo, declare: {} })
    expect(r.declared?.map((d) => d.name)).not.toContain('rogue')
    await rm(path.join(repo, '.lander/hooks/landed/any/rogue.js'))
  })

  // T2: blob existence is not the test. Both of these put an object in storage
  // that no commit reaches.
  it('does not see a `git hash-object -w` blob or a staged file', async () => {
    await writeHook(repo, '.lander/hooks/landed/any/staged.js', 'export const v = 1\n')
    git(repo, 'hash-object', '-w', '.lander/hooks/landed/any/staged.js')
    git(repo, 'add', '.lander/hooks/landed/any/staged.js')
    const r = await resolveHooks(gitExec, { cwd: repo, declare: {} })
    expect(r.declared?.map((d) => d.name)).not.toContain('staged')
    git(repo, 'rm', '-f', '--cached', '.lander/hooks/landed/any/staged.js')
    await rm(path.join(repo, '.lander/hooks/landed/any/staged.js'))
  })

  it('does not see a module nested below the principal directory', async () => {
    const r = await resolveHooks(gitExec, { cwd: repo, declare: {} })
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
      const r = await resolveHooks(gitExec, { cwd: repo, declare: {} })
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
      const r = await resolveHooks(gitExec, {
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
      const r = await resolveHooks(gitExec, {
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
      const r = await resolveHooks(gitExec, {
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

    it('reports a ref that does not resolve here', async () => {
      const r = await resolveHooks(gitExec, {
        cwd: repo,
        trustRoot: 'origin/nonexistent',
        declare: {},
      })
      expect(r.trustRoot).toEqual({ ref: 'origin/nonexistent', reason: 'unresolved-ref' })
      // The tree still resolves — a missing trust root is not a failure to answer.
      expect(r.declared?.length).toBeGreaterThan(0)
    })

    it('refuses a ref that could be read as a flag', async () => {
      const r = await resolveHooks(gitExec, {
        cwd: repo,
        trustRoot: '--upload-pack=touch /tmp/pwned',
        declare: {},
      })
      expect(r.trustRoot?.reason).toBe('invalid-ref')
      expect(r.trustRoot?.commit).toBeUndefined()
    })
  })
})

describe('resolveHooks outside a repository', () => {
  it('says so, and declares nothing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lander-hooks-bare-'))
    try {
      const r = await resolveHooks(gitExec, { cwd: dir, declare: {} })
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
      const r = await resolveHooks(gitExec, { cwd: dir, declare: {} })
      expect(r.reason).toBe('unborn-head')
      expect(r.declared).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
