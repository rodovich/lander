import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  anchorFileRule,
  makeFlow,
  onGrant,
  resolveLaunchDir,
  type ClaudeFlowDeps,
} from './claude'
import { captureDriverTurn, type DriverTurnFixture } from './testCtx'
import { gitContext } from 'lander/flow'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, existsSync: (p: string) => p === '/files/proj/t' || fs.existsSync(p) }
})

function runClaude(input: DriverTurnFixture, overrides: Partial<ClaudeFlowDeps> = {}) {
  return captureDriverTurn(makeFlow({
    landerBin: '/repo/bin/lander',
    taskPromptTemplate: 'Task prompt.',
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
        allow: ['Bash(npm test)'],
      },
      prompt: '-starts-with-dash',
      root: '/repo',
      cwd: '/repo',
      env: { LANDER_TASK: 'task-1' },
    })

    expect(launch.env).toMatchObject({ LANDER_TASK: 'task-1' })
    expect(launch.args).not.toContain('--worktree')
    // Edit access rides --permission-mode, not the allowlist: only Bash(lander:*)
    // and the per-task allow rule ride --allowedTools. git and other Bash follow
    // the project's .claude permissions.
    expect(launch.args.slice(2, 13)).toEqual([
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash(lander:*)',
      'Bash(npm test)',
      '--disallowedTools',
      'ScheduleWakeup',
      'CronCreate',
      'CronDelete',
      'CronList',
      '--add-dir',
    ])
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
    expect(settings.hooks.PostToolUse).toBeUndefined()
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(
      '/repo/bin/lander record-cwd',
    )

    const systemPrompt = launch.args[launch.args.indexOf('--append-system-prompt') + 1]
    expect(systemPrompt).toContain('Task prompt.')
    expect(systemPrompt).not.toContain('task-context block')
    // The kept git tips, minus the sign-off conventions that
    // includeGitInstructions:false removed along with the status snapshot.
    expect(systemPrompt).toContain('# Git')
    expect(systemPrompt).toContain('gh')
    expect(systemPrompt).not.toContain('Co-Authored-By')
    expect(settings.includeGitInstructions).toBe(false)
  })

  it('tells an agent in a lander checkout where it is, in the stable system prompt', async () => {
    const wt = '/repo/.worktrees/t1'
    const launch = await runClaude({
      task: {},
      root: '/repo',
      cwd: wt,
      checkout: wt,
    })
    const systemPrompt = launch.args[launch.args.indexOf('--append-system-prompt') + 1]
    expect(systemPrompt).toContain(
      'This task works in a git worktree lander created for it at `/repo/.worktrees/t1`',
    )
    expect(systemPrompt).toContain('Commit on a branch you create')
    // Spawned in the checkout, so acceptEdits covers it and nothing else.
    expect(launch.cwd).toBe(wt)

    const outside = await runClaude({ task: {}, root: '/repo', cwd: '/repo' })
    expect(
      outside.args[outside.args.indexOf('--append-system-prompt') + 1],
    ).not.toContain('git worktree lander created')
  })

  it('reads LANDER.md from the checkout, falling back to the root', async () => {
    const wt = '/repo/.worktrees/t1'
    const docs: Record<string, string> = { '/repo': 'ROOT DOC' }
    const read = (dir: string) => docs[dir]
    const fromRoot = await runClaude(
      { task: {}, root: '/repo', cwd: wt, checkout: wt },
      { readProjectDoc: read },
    )
    expect(fromRoot.args.join('\n')).toContain('ROOT DOC')
    docs[wt] = 'BRANCH DOC'
    const fromCheckout = await runClaude(
      { task: {}, root: '/repo', cwd: wt, checkout: wt },
      { readProjectDoc: read },
    )
    expect(fromCheckout.args.join('\n')).toContain('BRANCH DOC')
    expect(fromCheckout.args.join('\n')).not.toContain('ROOT DOC')
  })

  it('adds the files dir as a Read workspace root when one exists', async () => {
    const launch = await runClaude({
      task: {},
      prompt: 'look at this',
      root: '/repo',
      cwd: '/repo',
      env: { LANDER_TASK: 't', LANDER_FILES_DIR: '/files/proj/t' },
      filesDir: '/files/proj/t',
    })
    // --add-dir lets Read open the image under LANDER_FILES_DIR (outside cwd).
    const i = launch.args.indexOf('--add-dir')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(launch.args[i + 1]).toBe('/files/proj/t')
  })

  it('grants both scratch roots even without attachments', async () => {
    const launch = await runClaude({
      task: {},
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
      task: {},
      prompt: 'look at this',
      root: '/repo',
      cwd: '/repo',
      env: { LANDER_TASK: 't', LANDER_FILES_DIR: '/files/proj/t' },
      filesDir: '/files/proj/t',
    })
    expect(addDirsOf(launch.args)).toEqual(['/files/proj/t', ...SCRATCH_ROOTS])
  })

  it('builds the per-turn context block from the git snapshot', async () => {
    const { context } = await runClaude({
      task: {},
      root: '/repo',
      cwd: '/repo/worktree',
    })
    expect(context).toContain('<task-context>')
    expect(context).toContain('cwd /repo/worktree')
    expect(context).toContain('</task-context>')
  })

  it('sends no context block outside a git repo with nothing else to report', async () => {
    const launch = await runClaude({
      task: {},
      root: '/repo',
      cwd: '/repo',
    }, { gitContext: () => undefined })
    expect(launch.context).toBeUndefined()
    expect(launch.args.at(-1)).not.toContain('<task-context>')
  })

  it('lists task allow rules in the context block only when there are some', async () => {
    const { context } = await runClaude({
      task: { allow: ['Bash(npm test)', 'WebFetch'] },
      root: '/repo',
      cwd: '/repo',
    })
    expect(context).toContain(
      'Tool permissions granted to this task (beyond the defaults): ' +
        '`Bash(npm test)`, `WebFetch`',
    )
    const { context: none } = await runClaude({
      task: { allow: [] },
      root: '/repo',
      cwd: '/repo',
    })
    expect(none).not.toContain('Tool permissions granted')
  })

  describe('resolveLaunchDir', () => {
    const yes = () => true

    it('launches at root', async () => {
      expect(resolveLaunchDir({ root: '/repo', isDir: yes })).toEqual({ cwd: '/repo' })
    })

    it('ignores a wandered recordedCwd — it never becomes the launch dir', async () => {
      expect(
        resolveLaunchDir({
          root: '/repo',
          recordedCwd: '/tmp',
          isDir: yes,
        }),
      ).toEqual({ cwd: '/repo' })
    })
  })

  describe('manual-cd hint in the context block', () => {
    it('notes where the previous turn ended when that differs from the launch dir', async () => {
      const { context } = await runClaude({
        task: {},
        root: '/repo',
        cwd: '/repo',
        recordedCwd: '/repo/sub',
      })
      expect(context).toContain(
        'Note: your previous turn ended in sub. Depending how you moved there, ' +
          'that location may or may not have been preserved in this new turn. ' +
          'Check `pwd` before relying on the location.',
      )
    })

    it('stays silent on a plain root-to-root turn', async () => {
      const { context } = await runClaude({
        task: {},
        root: '/repo',
        cwd: '/repo',
        recordedCwd: '/repo',
      })
      expect(context).not.toContain('your previous turn ended')
    })

    // An adopted task's last shell was at the root, outside the checkout it now
    // launches in — pointing back there would send it to the main checkout.
    it('stays silent in a lander checkout about a dir outside it', async () => {
      const wt = '/repo/.worktrees/t1'
      const { context } = await runClaude({
        task: {},
        root: '/repo',
        cwd: wt,
        checkout: wt,
        recordedCwd: '/repo',
      })
      expect(context).not.toContain('your previous turn ended')
    })

    it('still notes a cd within a lander checkout', async () => {
      const wt = '/repo/.worktrees/t1'
      const { context } = await runClaude({
        task: {},
        root: '/repo',
        cwd: wt,
        checkout: wt,
        recordedCwd: `${wt}/app`,
      })
      expect(context).toContain('your previous turn ended in .worktrees/t1/app')
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

  it('snapshots the task checkout, not root', async () => {
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
    // The task's checkout, on its own branch with its own dirty file.
    const wtPath = path.join(root, '.worktrees', 't1')
    git(root, 'worktree', 'add', '-b', 'feature', wtPath)
    await writeFile(path.join(wtPath, 'wt-only.txt'), 'x')

    // The run launches in its checkout, and the block must describe the tree
    // the agent actually edits, not root.
    const { context } = await runClaude({
      task: {},
      root,
      cwd: wtPath,
      checkout: wtPath,
    }, { gitContext })
    expect(context).toContain('Current branch: feature')
    expect(context).toContain('?? wt-only.txt')
    expect(context).not.toContain('Current branch: main')

    // Guard the divergence this relies on: reading root would report the wrong
    // branch and miss the checkout's dirt.
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

describe('anchorFileRule', () => {
  it('re-anchors an absolute path for the path-taking tools', () => {
    expect(anchorFileRule('Read(/Users/me/f)')).toBe('Read(//Users/me/f)')
    expect(anchorFileRule('Edit(/Users/me/f)')).toBe('Edit(//Users/me/f)')
    expect(anchorFileRule('Write(/repo/a.ts)')).toBe('Write(//repo/a.ts)')
    expect(anchorFileRule('MultiEdit(/repo/a.ts)')).toBe('MultiEdit(//repo/a.ts)')
    expect(anchorFileRule('NotebookEdit(/repo/a.ipynb)')).toBe(
      'NotebookEdit(//repo/a.ipynb)',
    )
    // A path may itself hold parentheses; the rule ends at the last one.
    expect(anchorFileRule('Read(/Users/me/My (Notes)/f.md)')).toBe(
      'Read(//Users/me/My (Notes)/f.md)',
    )
  })

  it('leaves every other rule as written', () => {
    expect(anchorFileRule('Read(//Users/me/f)')).toBe('Read(//Users/me/f)')
    // A subagent can pass a relative path, which already resolves at the root.
    expect(anchorFileRule('Read(app/models/a.rb)')).toBe('Read(app/models/a.rb)')
    // A Bash rule's argument is a command that happens to start with a slash.
    expect(anchorFileRule('Bash(/usr/bin/env node)')).toBe('Bash(/usr/bin/env node)')
    expect(anchorFileRule('WebFetch(domain:example.com)')).toBe(
      'WebFetch(domain:example.com)',
    )
    expect(anchorFileRule('Read')).toBe('Read')
  })
})
