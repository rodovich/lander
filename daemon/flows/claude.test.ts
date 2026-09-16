import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { makeFlow, onGrant, resolveLaunchDir, type ClaudeFlowDeps } from './claude'
import { captureDriverTurn, type DriverTurnFixture } from './testCtx'
import { gitContext } from 'lander/flow'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, existsSync: (p: string) => p === '/files/proj/t' || fs.existsSync(p) }
})

function runClaude(input: DriverTurnFixture, overrides: Partial<ClaudeFlowDeps> = {}) {
  return captureDriverTurn(makeFlow({
    landerBin: '/repo/bin/lander',
    taskPromptTemplate: 'Prompt: {{forwardable}}.',
    gitContext: (cwd) => `Git status as of this message:\n\ncwd ${cwd}`,
    mint: () => 'minted',
    readProjectDoc: () => undefined,
    ...overrides,
  }), input)
}

// Every --add-dir value in argv order, so a test can assert the granted roots
// without pinning their position among the other flags.
const addDirsOf = (args: string[]) =>
  args.flatMap((a, i) => (a === '--add-dir' ? [args[i + 1]] : []))

// /tmp and os.tmpdir() are the same path on Linux and differ on macOS.
const SCRATCH_ROOTS = [...new Set(['/tmp', tmpdir()])]

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('Claude flow', () => {
  it('builds Claude launch arguments', async () => {
    const launch = await runClaude({
      task: {
        allowEdits: true,
        allow: ['Bash(npm test)'],
        worktree: 'feature',
      },
      prompt: '-starts-with-dash',
      root: '/repo',
      cwd: '/repo',
      env: { LANDER_TASK: 'task-1' },
    })

    expect(launch.env).toMatchObject({ LANDER_TASK: 'task-1' })
    // The --worktree re-entry argv is no longer built here — it moved to
    // resolveLaunchDir().reentryArgs (asserted separately). buildLaunch ignores
    // task.worktree entirely now.
    expect(launch.args).not.toContain('--worktree')
    // Edit access rides --permission-mode, not the allowlist: only Bash(lander:*)
    // and the per-task allow rule ride --allowedTools. git and other Bash follow
    // the project's .claude permissions.
    expect(launch.args.slice(2, 8)).toEqual([
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash(lander:*)',
      'Bash(npm test)',
      '--add-dir',
    ])
    // The scratch roots ride along with edit access.
    expect(addDirsOf(launch.args)).toEqual(SCRATCH_ROOTS)
    expect(launch.args.slice(-6, -1)).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '-p',
      '--',
    ])

    expect(launch.args.at(-1)).toContain('-starts-with-dash')
    const settings = JSON.parse(launch.args[launch.args.indexOf('--settings') + 1])
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(
      '/repo/bin/lander bash-guard',
    )
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe(
      '/repo/bin/lander record-worktree',
    )
    expect(settings.hooks.PostToolUse[1].hooks[0].command).toBe(
      '/repo/bin/lander clear-worktree',
    )
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(
      '/repo/bin/lander record-cwd',
    )

    const systemPrompt = launch.args[launch.args.indexOf('--append-system-prompt') + 1]
    // The appended prompt is static across turns: the live grants moved to the
    // task-context block, leaving a fixed pointer in the {{forwardable}} slot.
    expect(systemPrompt).toContain(
      'Prompt: Your own current grants — which cap what you can forward — are ' +
        'stated in the task-context block in the conversation.',
    )
    // The kept git tips, minus the sign-off conventions that
    // includeGitInstructions:false removed along with the status snapshot.
    expect(systemPrompt).toContain('# Git')
    expect(systemPrompt).toContain('gh')
    expect(systemPrompt).not.toContain('Co-Authored-By')
    expect(settings.includeGitInstructions).toBe(false)
  })

  it('adds the files dir as a Read workspace root when one exists', async () => {
    const launch = await runClaude({
      task: { allowEdits: false },
      prompt: 'look at this',
      root: '/repo',
      cwd: '/repo',
      env: { LANDER_TASK: 't', LANDER_FILES_DIR: '/files/proj/t' },
      images: ['/files/proj/t/img1'],
      filesDir: '/files/proj/t',
    })
    // --add-dir lets Read open the image under LANDER_FILES_DIR (outside cwd).
    const i = launch.args.indexOf('--add-dir')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(launch.args[i + 1]).toBe('/files/proj/t')
  })

  it('omits --add-dir when a read-only task has no attachment store', async () => {
    const launch = await runClaude({
      task: { allowEdits: false },
      prompt: 'no files',
      root: '/repo',
      cwd: '/repo',
      env: { LANDER_TASK: 't' },
    })
    expect(launch.args).not.toContain('--add-dir')
    expect(launch.args).not.toContain('--permission-mode')
  })

  // The scratch grant is scoped to edit access: acceptEdits auto-approves writes
  // to every --add-dir root, so handing a read-only task a writable scratch root
  // would be the one way it could still mutate the filesystem. Both roots are
  // granted because os.tmpdir() is not /tmp on macOS — it resolves $TMPDIR to a
  // per-user /var/folders/<hash>/T — and agents write to the literal /tmp.
  it('grants both scratch roots with edit access even without attachments', async () => {
    const launch = await runClaude({
      task: { allowEdits: true },
      prompt: 'no files',
      root: '/repo',
      cwd: '/repo',
      env: { LANDER_TASK: 't' },
    })
    expect(addDirsOf(launch.args)).toEqual(SCRATCH_ROOTS)
    expect(launch.args.slice(2, 4)).toEqual(['--permission-mode', 'acceptEdits'])
  })

  it('grants the scratch roots alongside the attachment store', async () => {
    const launch = await runClaude({
      task: { allowEdits: true },
      prompt: 'look at this',
      root: '/repo',
      cwd: '/repo',
      env: { LANDER_TASK: 't', LANDER_FILES_DIR: '/files/proj/t' },
      images: ['/files/proj/t/img1'],
      filesDir: '/files/proj/t',
    })
    expect(addDirsOf(launch.args)).toEqual(['/files/proj/t', ...SCRATCH_ROOTS])
  })

  it('builds the per-turn context block from grants and the git snapshot', async () => {
    const { context } = await runClaude({
      task: { allowEdits: true },
      root: '/repo',
      cwd: '/repo/worktree',
    })
    expect(context).toContain('<task-context>')
    expect(context).toContain(
      'You currently have permission for editing files',
    )
    expect(context).toContain('cwd /repo/worktree')
    expect(context).toContain('</task-context>')
  })

  it('degrades the context block to just the grants outside a git repo', async () => {
    const { context } = await runClaude({
      task: { allowEdits: false },
      root: '/repo',
      cwd: '/repo',
    }, { gitContext: () => undefined })
    expect(context).toContain('You currently have no edit permission')
    expect(context).not.toContain('Git status')
  })

  describe('resolveLaunchDir', () => {
    const yes = () => true

    it('launches at root with no re-entry when the task has no worktree', async () => {
      expect(
        resolveLaunchDir({ root: '/repo', isDir: yes }),
      ).toEqual({ cwd: '/repo', reentryArgs: [] })
    })

    it('launches at root and re-enters a worktree via argv', async () => {
      expect(
        resolveLaunchDir({
          root: '/repo',
          worktree: 'feature',
          isDir: yes,
        }),
      ).toEqual({
        cwd: '/repo',
        reentryArgs: ['--worktree', 'feature'],
        effectiveCwd: '/repo/.claude/worktrees/feature',
      })
    })

    it('ignores a wandered recordedCwd — it never becomes the launch dir', async () => {
      expect(
        resolveLaunchDir({
          root: '/repo',
          recordedCwd: '/tmp',
          isDir: yes,
        }),
      ).toEqual({ cwd: '/repo', reentryArgs: [] })
    })
  })

  describe('manual-cd hint in the context block', () => {
    it('warns when the previous shell ended somewhere this turn will not restore', async () => {
      const { context } = await runClaude({
        task: { allowEdits: false },
        root: '/repo',
        cwd: '/repo',
        recordedCwd: '/repo/sub',
      })
      expect(context).toContain("previous turn's shell ended in sub")
      expect(context).toContain('this turn starts at the project root')
    })

    it('stays silent on an EnterWorktree re-entry (landed == recorded)', async () => {
      const wt = '/repo/.claude/worktrees/feature'
      const { context } = await runClaude({
        task: { allowEdits: false, worktree: 'feature' },
        root: '/repo',
        cwd: '/repo',
        effectiveCwd: wt,
        recordedCwd: wt,
      })
      expect(context).not.toContain("previous turn's shell ended")
    })

    it('stays silent on a plain root-to-root turn', async () => {
      const { context } = await runClaude({
        task: { allowEdits: false },
        root: '/repo',
        cwd: '/repo',
        recordedCwd: '/repo',
      })
      expect(context).not.toContain("previous turn's shell ended")
    })

    it('points a hand-entered worktree at EnterWorktree', async () => {
      const { context } = await runClaude({
        task: { allowEdits: false },
        root: '/repo',
        cwd: '/repo',
        recordedCwd: '/repo/.claude/worktrees/feature',
      })
      expect(context).toContain('git worktree you entered by hand')
      expect(context).toContain('enter it with EnterWorktree')
      expect(context).toContain('borrows the worktree rather than owning it')
    })

    it('points a subdirectory of a hand-entered worktree there too', async () => {
      const { context } = await runClaude({
        task: { allowEdits: false },
        root: '/repo',
        cwd: '/repo',
        recordedCwd: '/repo/.claude/worktrees/feature/app/models',
      })
      expect(context).toContain('enter it with EnterWorktree')
    })

    it('does not suggest EnterWorktree for a plain subdirectory cd', async () => {
      const { context } = await runClaude({
        task: { allowEdits: false },
        root: '/repo',
        cwd: '/repo',
        recordedCwd: '/repo/sub',
      })
      expect(context).toContain("previous turn's shell ended in sub")
      expect(context).not.toContain('EnterWorktree')
    })

    // The task is already bound: the shell wandering within its worktree is an
    // ordinary cd, and telling it to enter the worktree it is in would be noise.
    it('does not suggest EnterWorktree when a worktree is already recorded', async () => {
      const { context } = await runClaude({
        task: { allowEdits: false, worktree: 'feature' },
        root: '/repo',
        cwd: '/repo',
        effectiveCwd: '/repo/.claude/worktrees/feature',
        recordedCwd: '/repo/.claude/worktrees/feature/app',
      })
      expect(context).toContain("previous turn's shell ended")
      expect(context).not.toContain('EnterWorktree')
    })
  })

  it('reads a real git snapshot: branch, status, recent commits', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lander-git-'))
    tempDirs.push(dir)
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
        { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    git('init', '-b', 'work')
    await writeFile(path.join(dir, 'a.txt'), 'a')
    git('add', 'a.txt')
    git('commit', '-m', 'first commit')
    await writeFile(path.join(dir, 'b.txt'), 'b')

    const snapshot = gitContext(dir)
    expect(snapshot).toContain('Current branch: work')
    expect(snapshot).toContain('?? b.txt')
    expect(snapshot).toContain('first commit')
  })

  it('returns no git snapshot outside a repository', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lander-nogit-'))
    tempDirs.push(dir)
    expect(gitContext(dir)).toBeUndefined()
  })

  it('snapshots the worktree, not root, for a worktree task', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lander-wt-'))
    tempDirs.push(root)
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args],
        { cwd, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    git(root, 'init', '-b', 'main')
    await writeFile(path.join(root, 'a.txt'), 'a')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '-m', 'root commit')
    // The worktree lives where `--worktree <name>` re-enters it, on its own
    // branch with its own dirty file.
    const wtPath = path.join(root, '.claude', 'worktrees', 'feature')
    git(root, 'worktree', 'add', '-b', 'feature', wtPath)
    await writeFile(path.join(wtPath, 'wt-only.txt'), 'x')

    // A worktree Claude task launches from root (resolveLaunchDir → cwd=root)
    // and lands in the worktree via --worktree; the daemon threads that landed
    // dir back as effectiveCwd, and the block must describe the worktree the
    // agent actually edits, not root.
    const { context } = await runClaude({
      task: { allowEdits: true, worktree: 'feature' },
      root,
      cwd: root,
      effectiveCwd: wtPath,
    }, { gitContext })
    expect(context).toContain('Current branch: feature')
    expect(context).toContain('?? wt-only.txt')
    expect(context).not.toContain('Current branch: main')

    // Guard the divergence the fix relies on: reading root (the launch cwd)
    // would report the wrong branch and miss the worktree's dirt.
    const rootSnapshot = gitContext(root)
    expect(rootSnapshot).toContain('Current branch: main')
    expect(rootSnapshot).not.toContain('wt-only.txt')
  })

  it('persists project grants in Claude settings.local.json', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lander-claude-'))
    tempDirs.push(dir)

    await onGrant(undefined, {
      projectPath: dir,
      rule: 'Bash(npm test)',
    })
    await onGrant(undefined, {
      projectPath: dir,
      rule: 'Bash(npm test)',
    })

    const settings = JSON.parse(
      await readFile(path.join(dir, '.claude', 'settings.local.json'), 'utf8'),
    )
    expect(settings.permissions.allow).toEqual(['Bash(npm test)'])
  })

})
