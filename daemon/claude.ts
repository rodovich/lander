import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AgentAdapter, AgentTaskView } from './agent'
import { reduceStreamLine } from '../server/stream'
// The git snapshot is stdlib now (flow/git.ts) — nothing about reading a repo's
// branch/status is claude-specific. Only the <task-context> wrapper below, which
// weaves the live permission grants around it, stays here.
import { gitContext } from 'lander/flow'
import { fillTaskPrompt, forwardableAccess } from './task-management'

export type ClaudeAdapterOptions = {
  landerBin: string
  taskPromptTemplate: string
  // The git-snapshot reader behind buildTurnContext, injectable for tests.
  // Returns the formatted snapshot, or undefined outside a git repository.
  readGitContext?: (cwd: string) => string | undefined
}

// Claude regenerates its default system prompt every invocation, and lander runs
// one `claude -p` process per turn — so anything dynamic in that prompt (the git
// status snapshot changes on any commit or file edit) busts the prompt cache for
// the entire conversation on the next turn. includeGitInstructions:false removes
// the snapshot along with the built-in git workflow instructions; the snapshot
// moves into the per-turn task-context block (buildTurnContext), and the
// instructions worth keeping return as static text below.

// The environment/workflow git tips from Claude's built-in git instructions,
// minus the commit/PR sign-off conventions (Co-Authored-By, PR attribution),
// which lander deliberately drops.
const GIT_TIPS = [
  '# Git',
  '- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.',
  '- Use the `gh` CLI for GitHub operations (PRs, issues, API).',
  '- Commit or push only when the user asks. If on the default branch, branch first.',
].join('\n')

// The static stand-in for the template's {{forwardable}} slot: the live grants
// sentence moved to the task-context block so the appended system prompt stays
// byte-stable across turns (see forwardableAccess / buildTurnContext).
const FORWARDABLE_POINTER =
  'Your own current grants — which cap what you can forward — are stated in ' +
  'the task-context block in the conversation'

// NOTE (Ship 2, verified on CLI 2.1.216): do NOT try to lengthen a quiet
// foreground command by pinning BASH_MAX_TIMEOUT_MS here. The CLI caps a
// foreground Bash command at a hard ~600s and then AUTO-MOVES it to the
// background (it does not kill it); BASH_MAX_TIMEOUT_MS does not raise that cap.
// Delivery-guaranteed test: a task on a daemon carrying a 1_800_000 pin on BOTH
// the process env and the --settings `env` block, running a command with an
// explicit tool timeout of 780_000, was still backgrounded at exactly 600s
// (task GviAkz32EN). So the pin is inert for this purpose and was removed. The
// operative fix lives entirely in the idle-watchdog window (server/index.ts
// idleTimeoutMs), set ABOVE 600s so the CLI's auto-background — which returns
// control to the agent and emits a stream event — always beats the watchdog.
// Before that, the watchdog sat AT 600s, tying the cap and wedging the ride when
// it won by ~50ms (easel PcnoAnNEyG, 4/4). Making a >600s foreground command
// actually complete requires the agent to consume the auto-backgrounded task
// in-turn (poll BashOutput) rather than ending the turn — that's agent guidance
// (Ship 1/3), not an env knob.

export function createClaudeAdapter({
  landerBin,
  taskPromptTemplate,
  readGitContext = gitContext,
}: ClaudeAdapterOptions): AgentAdapter {
  return {
    kind: 'claude',
    command: 'claude',
    buildLaunch({ task, prompt, landerEnv, filesDir }) {
      return {
        args: buildClaudeArgs(task, prompt, {
          landerBin,
          taskPromptTemplate,
          // Claude reads an attached image by its local path, but that path is
          // under LANDER_FILES_DIR — outside the task's working dir — so Read is
          // denied without a grant (and lander runs non-interactively, so no
          // approval prompt). Add the store dir as an extra workspace root so Read
          // can open it. Scoped to that one dir (no broader disk access), and set
          // by the run manager only when the dir exists — so an image stays
          // readable on any later turn, not just the one that attached it.
          filesDir,
        }),
        env: landerEnv,
      }
    },
    buildTurnContext({ task, root, cwd, effectiveCwd, recordedCwd }) {
      const parts = [`${forwardableAccess(task)}.`]
      // A worktree Claude task launches from the project root (resolveLaunchDir
      // hands cwd=root and re-enters the worktree via --worktree) — so read the
      // snapshot from where the shell actually lands (effectiveCwd = the worktree),
      // not root, or the block would describe the wrong branch and dirty tree.
      const landed = effectiveCwd ?? cwd
      const git = readGitContext(landed)
      if (git) parts.push(git)
      // A manual `cd` last turn (into a subdir or /tmp) recorded that dir as
      // task.cwd, but this turn launches at root and won't restore it — tell the
      // agent its shell moved back so it can cd again if it still needs to. Fires
      // only when the landed dir differs from where the shell ended; an
      // EnterWorktree re-entry lands back in the recorded worktree, so it stays
      // silent.
      if (recordedCwd && recordedCwd !== landed)
        parts.push(manualCdHint(root, recordedCwd, landed))
      return [
        '<task-context>',
        'Task state as of this message — background context from lander, not ' +
          "the user's words. Re-sent only when it changes.",
        '',
        parts.join('\n\n'),
        '</task-context>',
      ].join('\n')
    },
    buildSession({ sessionId, mintSessionId }) {
      if (sessionId)
        return {
          args: ['--resume', sessionId],
          sessionId,
          announceSession: false,
        }
      const minted = mintSessionId()
      return {
        args: ['--session-id', minted],
        sessionId: minted,
        announceSession: true,
      }
    },
    resolveLaunchDir({ root, worktree }) {
      // Claude always launches at the project root — that's its permission
      // boundary and config-load root, so it must never drift to a wandered cwd.
      // A worktree is re-entered through argv (--worktree), landing the shell in
      // the worktree without moving the boundary. recordedCwd is deliberately
      // ignored: a manual `cd` last turn does not become this turn's root.
      if (worktree)
        return {
          cwd: root,
          reentryArgs: ['--worktree', worktree],
          effectiveCwd: path.join(root, '.claude', 'worktrees', worktree),
        }
      return { cwd: root, reentryArgs: [] }
    },
    reduceLine: reduceStreamLine,
    persistProjectGrant: persistClaudeProjectGrant,
    supportsProjectGrants: true,
    supportsUsageSnapshot: true,
    supportsRateLimitRetryScheduling: true,
    // Claude has no vision flag on the CLI: it Reads an image by its local path
    // (rendered visually), which the daemon lists in the manifest block.
    attachesImagesToVision: false,
  }
}

function buildClaudeArgs(
  task: AgentTaskView,
  prompt: string,
  {
    landerBin,
    taskPromptTemplate,
    filesDir,
  }: {
    landerBin: string
    taskPromptTemplate: string
    filesDir?: string
  },
): string[] {
  // Extra workspace root for the materialized attachment store, so Read can open
  // an attached image sitting outside the task's cwd (see buildLaunch). Only set
  // when the turn has images.
  const filesDirArgs = filesDir ? ['--add-dir', filesDir] : []
  // Edit access rides on --permission-mode acceptEdits rather than an
  // --allowedTools grant. An Edit/Write allow rule is "explicit permission", so
  // it escapes the working-directory boundary entirely (a granted Write can
  // create /tmp/anything); acceptEdits instead auto-approves file edits and the
  // filesystem Bash commands (mkdir/touch/rm/rmdir/mv/cp/sed) only for paths in
  // the cwd or an --add-dir root, and never for protected paths (.git, .claude).
  // That both closes the escape and gives edit-capable tasks the delete access a
  // bare Edit/Write grant can't express. It widens nothing else: python3, node,
  // curl and friends still follow the project's normal .claude permissions
  // (settings.json / settings.local.json) plus any per-task allow rules below.
  const editModeArgs = task.allowEdits ? ['--permission-mode', 'acceptEdits'] : []
  // Shared scratch roots. Agents reach for /tmp constantly for probe scripts and
  // diff dumps; without it they burn turns getting blocked and then route around
  // the block anyway. Grant BOTH the literal /tmp (what agents type by name) and
  // os.tmpdir() — on macOS those differ: tmpdir() resolves $TMPDIR to a per-user
  // /var/folders/<hash>/T, so granting only one leaves the other blocked. Deduped
  // for Linux, where they're the same path, and existence-filtered because
  // --add-dir rejects a path that isn't a directory (no /tmp on Windows). In
  // acceptEdits every --add-dir root is writable, so gate on edit access.
  const scratchRoots = task.allowEdits
    ? [...new Set(['/tmp', tmpdir()])].filter((dir) => existsSync(dir))
    : []
  const tmpDirArgs = scratchRoots.flatMap((dir) => ['--add-dir', dir])
  const allowed: string[] = ['Bash(lander:*)']
  if (task.allow?.length) allowed.push(...task.allow)
  const editArgs = ['--allowedTools', ...allowed]

  const hookSettings = JSON.stringify({
    // Keep the git status snapshot (and built-in git workflow instructions) out
    // of the regenerated-per-turn system prompt — see the note on GIT_TIPS.
    includeGitInstructions: false,
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            {
              type: 'command',
              command: `${landerBin} bash-guard`,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'EnterWorktree',
          hooks: [
            {
              type: 'command',
              command: `${landerBin} record-worktree`,
            },
          ],
        },
        {
          matcher: 'ExitWorktree',
          hooks: [
            {
              type: 'command',
              command: `${landerBin} clear-worktree`,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: 'command',
              command: `${landerBin} record-cwd`,
            },
          ],
        },
      ],
    },
  })

  // The --worktree re-entry argv now comes from resolveLaunchDir().reentryArgs
  // (prepended at the launch site), so worktree knowledge lives in one method.
  return [
    ...editModeArgs,
    ...editArgs,
    ...filesDirArgs,
    ...tmpDirArgs,
    '--settings',
    hookSettings,
    '--append-system-prompt',
    `${fillTaskPrompt(taskPromptTemplate, FORWARDABLE_POINTER)}\n\n${GIT_TIPS}`,
    '--output-format',
    'stream-json',
    '--verbose',
    '-p',
    '--',
    prompt,
  ]
}

// The manual-cd note for the task-context block: the previous turn's shell ended
// somewhere this turn's launch won't restore (a plain `cd` into a subdir or /tmp,
// recorded as task.cwd), so tell the agent its shell moved back and it can cd
// again if it still needs to. Paths are shown relative to root for brevity.
function manualCdHint(root: string, recordedCwd: string, landed: string): string {
  const rel = (p: string) => path.relative(root, p) || 'the project root'
  return (
    `Note: your previous turn's shell ended in ${rel(recordedCwd)}, but this ` +
    `turn starts at ${rel(landed)} (a manual cd isn't carried across turns) — ` +
    `cd back if you still need to work there.`
  )
}

async function persistClaudeProjectGrant({
  projectPath,
  rule,
}: {
  projectPath: string
  rule: string
}): Promise<void> {
  const dir = path.join(projectPath, '.claude')
  const file = path.join(dir, 'settings.local.json')
  let settings: Record<string, any> = {}
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed && typeof parsed === 'object') settings = parsed
  } catch {
    // missing or invalid — start fresh
  }
  const perms = (settings.permissions ??= {})
  const allow: string[] = Array.isArray(perms.allow)
    ? perms.allow
    : (perms.allow = [])
  if (!allow.includes(rule)) allow.push(rule)
  await mkdir(dir, { recursive: true })
  await writeFile(file, JSON.stringify(settings, null, 2) + '\n')
}
