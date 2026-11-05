// Codex as a driver flow. Shorter than claude's because codex carries less: no
// session minting (the thread id arrives in the stream), no per-turn context
// block, and no project grants to own.
//
// What it carries instead is deliver-once. Codex has no request-scoped channel
// for lander's own prose — claude appends to the system prompt, which is rebuilt
// every invocation — so the task-management prompt has to ride the user message,
// where a copy sent on one turn is replayed on every later one. It is therefore
// delivered once per thread and re-delivered only when its rendered text changes.
//
// What it does carry that claude doesn't is an in-stream error channel — codex
// reports failures as `error` / `turn.failed` events, which fold into the turn's
// exit rather than arriving as a non-zero exit code.

import path from 'node:path'
import { codexAppServerRequest } from '../codex-app-server'
import { codexConfigArgs } from '../codex-config'
import { execFileSync } from 'node:child_process'
import { toIso, usageStatus, type UsageBody, type UsageStatus, type UsageWindow } from '../../server/usage'
import {
  codexTurnUsage,
  extractCodexSession,
  prepareUserMessagePrompt,
  readThreadUsage,
  reduceCodexStreamLine,
  type Usage,
} from 'lander/flow'
import type { Ctx, FlowMeta, ToolHandle, TurnResult } from './ctx'
import type { AgentLaunchDir, AgentLaunchDirInput } from '../agent'

export { codexOptionsFromEnv } from '../codex-config'

export const meta: FlowMeta = {
  api: 1,
  name: 'codex',
  description: 'Drive a task as a Codex conversation',
  driver: true,
  capabilities: {
    grants: { task: false, project: false },
    usageSnapshot: true,
    rateLimitRetry: false,
    // Codex reports tokens without an account cost.
    reportsCost: false,
  },
  inputs: {},
  projectGrantsUnsupportedReason:
    'Project permission grants are not supported for Codex tasks yet.',
}

const CODEX_SHELL_ENV_INCLUDE_ONLY = ['PATH', 'LANDER_*'] as const

// A fresh `codex exec` (not `exec resume`) prints this to stderr when its stdin
// isn't a terminal, and the daemon gives it /dev/null. Left in, it is the first
// stderr line of a failed first turn, which the retry ask quotes as the cause.
const STDIN_BANNER = 'Reading additional input from stdin...'

export type CodexFlowDeps = {
  taskPromptTemplate: string
  profile?: string
  configOverrides?: string[]
  // The git dirs a commit from `cwd` writes outside the workspace: the
  // repository's common dir, and — in a linked worktree — that worktree's own
  // admin dir. Empty outside a repository.
  resolveGitDirs?: (cwd: string) => string[]
  // The project's optional LANDER.md. REQUIRED, with no default — see the note
  // on ClaudeFlowDeps: a default makes the goldens green by accident.
  readProjectDoc: (dir: string) => string | undefined
  // The installed codex's version, for the ride's record.
  readCliVersion?: () => Promise<string | undefined>
  // The model and reasoning effort most recently saved with a thread, for the
  // ride's usage.
  readThreadSettings?: (threadId: string) => Promise<CodexThreadSettings>
}

export type CodexThreadSettings = { model?: string; effort?: string }

export type CodexFlow = {
  meta: FlowMeta
  onTurn(ctx: Ctx): Promise<TurnResult>
}

export function makeFlow({
  taskPromptTemplate,
  profile,
  configOverrides = [],
  resolveGitDirs = resolveGitDirsWithGit,
  readProjectDoc,
  readCliVersion,
  readThreadSettings,
}: CodexFlowDeps): CodexFlow {
  return {
    meta,
    async onTurn(ctx: Ctx): Promise<TurnResult> {
      const version = readCliVersion?.()
      // ── Session ──────────────────────────────────────────────────────────
      // Nothing is minted: codex names its own thread and reports it in-stream.
      // The seed falls back to the legacy top-level wire field for a task whose
      // session predates the storage flip.
      const known = ctx.state.get(['sessionId'])
      const sessionId = typeof known === 'string' && known ? known : undefined

      const { prompt, commitDelivered } = prepareUserMessagePrompt(ctx, {
        sessionId,
        taskPromptTemplate,
        readProjectDoc,
      })

      const args = buildCodexArgs(ctx, prompt, sessionId, {
        profile,
        configOverrides,
        gitDirs: resolveGitDirs(ctx.task.cwd),
      })

      const cliVersion = version && await version
      if (cliVersion) ctx.emit.meter({ cliVersion })
      const child = ctx.spawn('codex', args, {
        env: {
          ...ctx.task.env,
          ...(ctx.turn.filesDir ? { LANDER_FILES_DIR: ctx.turn.filesDir } : {}),
          ...(ctx.turn.run ? { LANDER_RUN: ctx.turn.run } : {}),
        },
      })

      // ── Reduce ───────────────────────────────────────────────────────────
      const tools = new Map<string, ToolHandle>()
      // The thread's running total as of the previous turn, which this turn's
      // usage is the difference from. A fresh thread starts from zero. A thread
      // resumed before any total was saved has no baseline, and its turn is left
      // without usage rather than charged the whole total: the undercount is one
      // turn, the overcount would be every earlier turn of the thread again, and
      // it happens once per thread. A turn killed before turn.completed leaves the
      // baseline behind, so its usage lands on the next turn instead of vanishing.
      const priorTotal: Usage | undefined = sessionId
        ? readThreadUsage(ctx.state.get(['threadUsage']))
        : { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
      let terminalError: string | undefined
      let announced = sessionId !== undefined
      let stderrText = ''
      // Proof the model consumed this turn — and therefore that the thread holds
      // this turn's user message. A terminal error folds into `terminalError`
      // with no steps and no finalText, so a turn that only failed leaves this
      // false and the task prompt is re-sent next turn. `steps.length` (not
      // finalText) is what catches an empty agent_message, which still pushes a
      // text step.
      let producedOutput = false
      let settings: Promise<CodexThreadSettings & { usage: Usage }> | undefined

      const collectStderr = (async () => {
        for await (const l of child.stderr)
          if (l.trim() !== STDIN_BANNER) stderrText += `${l}\n`
      })()

      for await (const line of child.lines()) {
        const trimmed = line.trim()
        if (!trimmed) continue

        // Only the first thread.started of a genuinely new thread is a write. A
        // resumed turn re-emits the event, and persisting it again would produce
        // a redundant state-patch on every resumed turn.
        if (!announced) {
          const found = extractCodexSession(trimmed)
          if (found) {
            announced = true
            ctx.state.set(['sessionId'], found)
          }
        }

        const r = reduceCodexStreamLine(trimmed, ctx.now())
        // turn.started only suggests the thread holds the message; whether it is
        // on disk if codex is killed right after is untested. That is good
        // enough for the retry choice, where a wrong guess costs one nudge the
        // user must follow with a resend, but not for the delivery commit below,
        // where a wrong guess loses the task prompt for good.
        if (r.turnStarted) ctx.emit.committed()

        // A notice doesn't count: Codex reports config warnings before the turn
        // starts, so one proves nothing about the model reading the prompt.
        if ((r.steps.length && !r.notice) || r.finalText !== undefined)
          producedOutput = true

        if (r.terminalError) {
          if (!terminalError) terminalError = r.terminalError
          else if (!terminalError.includes(r.terminalError))
            terminalError += `\n${r.terminalError}`
        }

        for (const step of r.steps) {
          if (step.kind === 'tool_use') {
            const h = ctx.emit.tool({
              name: step.tool ?? '',
              input: step.input ?? '',
              ...(step.inputFull !== undefined
                ? { inputFull: step.inputFull }
                : {}),
              ...(step.rule !== undefined ? { rule: step.rule } : {}),
              ...(step.edits !== undefined ? { edits: step.edits } : {}),
            })
            if (step.toolUseId !== undefined) tools.set(step.toolUseId, h)
          } else if (step.kind === 'text') {
            ctx.emit.message(step.text ?? '')
          } else {
            // A result whose call was never observed opening still has to land;
            // synthesize the open so the lifecycle is well-formed.
            const localId = step.toolUseId
            let h = localId !== undefined ? tools.get(localId) : undefined
            if (!h) {
              h = ctx.emit.tool({
                name: step.tool ?? '',
                input: step.input ?? '',
              })
              if (localId !== undefined) tools.set(localId, h)
            }
            h.result({
              ...(step.text !== undefined ? { output: step.text } : {}),
              ...(step.isError !== undefined ? { isError: step.isError } : {}),
            })
          }
        }

        if (r.finalText !== undefined) ctx.emit.reply(r.finalText)

        // No blocked-status folding to reproduce: codex's public stream omits
        // sandbox-denied shell items entirely, so a refused call never appears.

        if (r.threadUsage) {
          const usage = codexTurnUsage(r.threadUsage, priorTotal)
          if (usage) {
            ctx.emit.meter({ usage })
            const threadId = ctx.state.get(['sessionId'])
            if (readThreadSettings && typeof threadId === 'string')
              settings = readThreadSettings(threadId)
                .catch(() => ({}))
                .then((s) => ({ usage, ...s }))
          }
          ctx.state.set(['threadUsage'], r.threadUsage)
        }
      }

      if (producedOutput) commitDelivered()

      const exitCode = await child.exit
      await collectStderr
      const stamped = settings && !ctx.signal.aborted ? await settings : undefined
      if (stamped?.model || stamped?.effort)
        ctx.emit.meter({
          usage: stamped.effort ? { ...stamped.usage, effort: stamped.effort } : stamped.usage,
          drivingModel: stamped.model,
        })
      return {
        // A clean exit that nonetheless folded a terminal error reports failed.
        exitCode: exitCode === 0 && terminalError ? 1 : exitCode,
        stderr: [stderrText.trim(), terminalError?.trim()]
          .filter(Boolean)
          .join('\n'),
      }
    },
  }
}

function buildCodexArgs(
  ctx: Ctx,
  prompt: string,
  sessionId: string | undefined,
  {
    profile,
    configOverrides,
    gitDirs,
  }: {
    profile?: string
    configOverrides: string[]
    gitDirs: string[]
  },
): string[] {
  const configOverridesWithLanderDefaults = [
    ...configOverrides,
    // The task's checkout is its whole workspace when it has one, matching
    // Claude, whose edit boundary is the dir it is spawned in.
    ...codexPermissionConfigOverrides(
      ctx.task.checkout ?? ctx.task.root,
      gitDirs,
    ),
    ...codexShellEnvConfigOverrides(),
  ]
  // The terminator keeps user prompts beginning with `-` out of argv parsing.
  // `--skip-git-repo-check` because a project need not be a git repo, and
  // without it codex refuses to run outside a trusted one (confirmed v0.154.0:
  // exit 1, "Not inside a trusted directory…"). Given at the exec level, it
  // holds for `exec resume` too.
  if (sessionId)
    return [
      'exec',
      '--json',
      '--skip-git-repo-check',
      ...codexConfigArgs(profile, configOverridesWithLanderDefaults),
      '--cd',
      ctx.task.cwd,
      'resume',
      sessionId,
      '--',
      prompt,
    ]
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    ...codexConfigArgs(profile, configOverridesWithLanderDefaults),
    '--cd',
    ctx.task.cwd,
    '--',
    prompt,
  ]
}

// Edit access is a synthesized permission profile rather than a --sandbox mode,
// so the writable workspace can be pinned to the resolved project root and the
// .git rules spelled out.
function codexPermissionConfigOverrides(
  projectRoot: string,
  gitDirs: string[],
): string[] {
  const profileId = 'lander-edit'
  const filesystemRules = [
    `${tomlString(':workspace_roots')}={${tomlEntry('.git', 'write')}}`,
    ...gitDirs.map((dir) => tomlEntry(path.resolve(dir), 'write')),
  ].join(',')
  const profileValue = [
    `description=${tomlString('Lander workspace edit access')}`,
    `extends=${tomlString(':workspace')}`,
    `workspace_roots={${tomlString(path.resolve(projectRoot))}=true}`,
    `filesystem={${filesystemRules}}`,
    'network={enabled=true,allow_local_binding=true}',
  ].join(',')

  return [
    `default_permissions=${tomlString(profileId)}`,
    `permissions.${profileId}={${profileValue}}`,
  ]
}

// The common dir alone is not enough for a linked worktree. Measured in a
// lander-made worktree on codex 0.159.2: with the common dir granted,
// `git switch -c` created the branch ref but could not take
// `.git/worktrees/<id>/HEAD.lock` (EPERM) — although the recorded sandbox
// policy put that path under a writable root, and a hand-run `codex exec` with
// the same argv and env could write it. Granting the worktree's own git dir by
// name fixed it.
function resolveGitDirsWithGit(cwd: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))]
  } catch {
    return []
  }
}

function codexShellEnvConfigOverrides(): string[] {
  // Let Lander vars flow from the child process env so LANDER_TOKEN stays out of
  // argv, and keep everything else in the host env out of Codex's shells.
  return [
    'shell_environment_policy.inherit=all',
    'shell_environment_policy.ignore_default_excludes=true',
    `shell_environment_policy.include_only=${tomlArray(
      CODEX_SHELL_ENV_INCLUDE_ONLY,
    )}`,
  ]
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlEntry(key: string, value: string): string {
  return `${tomlString(key)}=${tomlString(value)}`
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

// The app-server's `account/rateLimits/read` result as the usage panel's two
// windows. The schema leaves each window's length to its `windowDurationMins`;
// on a ChatGPT plan `primary` has been the 5-hour window and `secondary` the
// weekly one (0.166.0).
export function codexUsageBody(result: unknown): UsageBody | null {
  const limits = asRecord(asRecord(result)?.rateLimits)
  const window = (w: unknown): UsageWindow | null => {
    const r = asRecord(w)
    if (typeof r?.usedPercent !== 'number') return null
    return { utilization: r.usedPercent, resetsAt: toIso(r.resetsAt) }
  }
  const body = { session: window(limits?.primary), weekly: window(limits?.secondary) }
  return body.session || body.weekly ? body : null
}

export async function onStatus(): Promise<UsageStatus | null> {
  const body = codexUsageBody(await codexAppServerRequest('account/rateLimits/read', undefined))
  return body ? usageStatus(body) : null
}

// The app-server answering `thread/read` is lander's own fresh one, which never
// has the thread loaded, so the model and effort are the latest ones saved with
// the thread rather than any live configuration.
export function codexThreadSettings(result: unknown): CodexThreadSettings {
  const thread = asRecord(asRecord(result)?.thread)
  const { model, reasoningEffort: effort } = thread ?? {}
  return {
    ...(typeof model === 'string' && model ? { model } : {}),
    ...(typeof effort === 'string' && effort ? { effort } : {}),
  }
}

export async function readThreadSettings(threadId: string): Promise<CodexThreadSettings> {
  return codexThreadSettings(
    await codexAppServerRequest('thread/read', { threadId }, { timeoutMs: 10_000 }),
  )
}

// Where codex launches its next turn. Pure, and called by the DAEMON pre-host.
export function resolveLaunchDir({
  root,
  recordedCwd,
  isDir,
}: AgentLaunchDirInput): AgentLaunchDir {
  // It resumes from the cwd the previous turn ended in (relayed as --cd),
  // falling back to root when that cwd is missing, gone, or already root. Its
  // writable sandbox is pinned to the project root independent of --cd, so a
  // wandered cwd never loses project access.
  return {
    cwd: recordedCwd && recordedCwd !== root && isDir(recordedCwd) ? recordedCwd : root,
  }
}
