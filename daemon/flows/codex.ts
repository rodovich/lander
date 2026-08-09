// Codex as a driver flow. Shorter than claude's because codex carries less: no
// session minting (the thread id arrives in the stream), no per-turn context
// block (its managed prompt interpolates the live grants every turn anyway), and
// no project grants or usage snapshot to own.
//
// What it does carry that claude doesn't is an in-stream error channel — codex
// reports failures as `error` / `turn.failed` events, which fold into the turn's
// exit rather than arriving as a non-zero exit code.
//
// The reducer and session extractor are imported from the stdlib rather than
// absorbed: their source stays in daemon/codex.ts behind the façade until the
// compiled adapters are deleted, so the flow and its parity oracle call the
// identical function.

import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  addUsage,
  extractCodexSession,
  promptWithTaskManagement,
  reduceCodexStreamLine,
  type Usage,
} from 'lander/flow'
import type { Ctx, FlowMeta, ToolHandle, TurnResult } from './ctx'

export const meta: FlowMeta = {
  api: 1,
  name: 'codex',
  description: 'Drive a task as a Codex conversation',
  driver: true,
  capabilities: {
    // Codex has no worktree flag: it resumes from the recorded cwd instead.
    worktrees: false,
    // Codex takes image paths on the CLI and delivers them to its own vision,
    // so the manifest block words them as already attached.
    vision: 'flag',
    grants: { task: false, project: false },
    usageSnapshot: false,
    rateLimitRetry: false,
    // Codex reports tokens without an account cost.
    reportsCost: false,
  },
  inputs: {},
  projectGrantsUnsupportedReason:
    'Project permission grants are not supported for Codex tasks yet.',
}

const CODEX_SHELL_ENV_INCLUDE_ONLY = ['PATH', 'LANDER_*'] as const

export type CodexFlowDeps = {
  taskPromptTemplate: string
  profile?: string
  configOverrides?: string[]
  resolveGitCommonDir?: (cwd: string) => string | undefined
}

export type CodexFlow = {
  meta: FlowMeta
  onTurn(ctx: Ctx): Promise<TurnResult>
}

export function makeFlow({
  taskPromptTemplate,
  profile,
  configOverrides = [],
  resolveGitCommonDir = resolveGitCommonDirWithGit,
}: CodexFlowDeps): CodexFlow {
  return {
    meta,
    async onTurn(ctx: Ctx): Promise<TurnResult> {
      // ── Session ──────────────────────────────────────────────────────────
      // Nothing is minted: codex names its own thread and reports it in-stream.
      // The seed falls back to the legacy top-level wire field for a task whose
      // session predates the storage flip.
      const known = ctx.state.get(['sessionId'])
      const sessionId = typeof known === 'string' && known ? known : undefined

      // ── Prompt ───────────────────────────────────────────────────────────
      const promptParts = [ctx.turn.prompts.join('\n\n')]
      if (ctx.turn.manifestBlock) promptParts.push(ctx.turn.manifestBlock)
      // Codex has no turn-context block to hide this in, which is half of why the
      // revival notice is a prompt part rather than an adapter concern.
      if (ctx.turn.revivedBlock) promptParts.push(ctx.turn.revivedBlock)

      const args = [
        ...ctx.task.reentryArgs,
        ...buildCodexArgs(ctx, promptParts.join('\n\n'), sessionId, {
          taskPromptTemplate,
          profile,
          configOverrides,
          gitCommonDir: ctx.task.allowEdits
            ? resolveGitCommonDir(ctx.task.cwd)
            : undefined,
        }),
      ]

      const child = ctx.spawn('codex', args, {
        env: {
          ...ctx.task.env,
          ...(ctx.turn.filesDir ? { LANDER_FILES_DIR: ctx.turn.filesDir } : {}),
        },
      })

      // ── Reduce ───────────────────────────────────────────────────────────
      const tools = new Map<string, ToolHandle>()
      let usage: Usage | undefined
      let usageInf: string | undefined
      let terminalError: string | undefined
      let announced = sessionId !== undefined
      let stderrText = ''

      const collectStderr = (async () => {
        for await (const l of child.stderr) stderrText += `${l}\n`
      })()

      for await (const line of child.lines()) {
        const trimmed = line.trim()
        if (!trimmed) continue

        // Only the first thread.started of a genuinely new thread is a write. A
        // resumed turn re-emits the event, and persisting it again would produce
        // a state-patch the adapter never sends.
        if (!announced) {
          const found = extractCodexSession(trimmed)
          if (found) {
            announced = true
            ctx.state.set(['sessionId'], found)
          }
        }

        const r = reduceCodexStreamLine(trimmed, ctx.now())

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
            // Codex reports item.failed for a command it never announced
            // starting, so a result with no observed open is normal here, not an
            // edge case. Synthesize the open so the lifecycle is well-formed.
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

        if (r.usage) {
          if (r.usageFinal) {
            usage = usage?.cacheMiss
              ? { ...r.usage, cacheMiss: usage.cacheMiss }
              : r.usage
            ctx.emit.meter({ usage })
          } else if (r.usageInferenceId !== usageInf) {
            usageInf = r.usageInferenceId
            usage = addUsage(usage, r.usage)
            ctx.emit.meter({ usage })
          }
        }
      }

      const exitCode = await child.exit
      await collectStderr
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
    taskPromptTemplate,
    profile,
    configOverrides,
    gitCommonDir,
  }: {
    taskPromptTemplate: string
    profile?: string
    configOverrides: string[]
    gitCommonDir?: string
  },
): string[] {
  const configOverridesWithLanderDefaults = [
    ...configOverrides,
    ...codexPermissionConfigOverrides(
      ctx.task.allowEdits,
      ctx.task.root,
      gitCommonDir,
    ),
    ...codexShellEnvConfigOverrides(),
  ]
  const managedPrompt = promptWithTaskManagement(
    {
      agent: 'codex',
      allowEdits: ctx.task.allowEdits,
      ...(ctx.task.allow !== undefined ? { allow: ctx.task.allow } : {}),
      ...(ctx.task.worktree !== undefined
        ? { worktree: ctx.task.worktree }
        : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
    prompt,
    taskPromptTemplate,
    ctx.task.taskId,
  )
  // One `-i <path>` per image (the repeatable short form), then `--`, then the
  // prompt. The terminator is what makes the placement uniform across both
  // paths: without it a fresh `exec`'s variadic --image swallows a trailing
  // positional, which is why the flags used to sit AFTER the prompt there.
  // Everything past `--` is positional, so the flags must precede it — and a
  // prompt that begins with `-` stops being parsed as argv. Today the prompt
  // always leads with the task-management template, so no user text can reach
  // argv position 1; the terminator is what keeps that a property of the argv
  // rather than of the prompt's contents (confirmed Codex v0.144.5: a bare
  // `- bullet…` prompt errors with "unexpected argument", and codex's own tip
  // is to pass it after `--`).
  const imageArgs = ctx.turn.images.flatMap((p) => ['-i', p])
  if (sessionId)
    return [
      'exec',
      '--json',
      ...codexConfigArgs(profile, configOverridesWithLanderDefaults),
      '--cd',
      ctx.task.cwd,
      'resume',
      sessionId,
      ...imageArgs,
      '--',
      managedPrompt,
    ]
  return [
    'exec',
    '--json',
    ...codexConfigArgs(profile, configOverridesWithLanderDefaults),
    '--cd',
    ctx.task.cwd,
    ...imageArgs,
    '--',
    managedPrompt,
  ]
}

// Edit access is a scoped permission profile, not a --sandbox mode: a synthesized
// `lander-edit` / `lander-read-only` profile pins the writable workspace to the
// resolved project root and spells out the .git rules.
function codexPermissionConfigOverrides(
  allowEdits: boolean,
  projectRoot: string,
  gitCommonDir: string | undefined,
): string[] {
  const profileId = allowEdits ? 'lander-edit' : 'lander-read-only'
  const baseProfile = allowEdits ? ':workspace' : ':read-only'
  const filesystemRules = allowEdits
    ? [
        `${tomlString(':workspace_roots')}={${tomlEntry('.git', 'write')}}`,
        ...(gitCommonDir ? [tomlEntry(path.resolve(gitCommonDir), 'write')] : []),
      ].join(',')
    : undefined
  const profileValue = [
    `description=${tomlString(
      allowEdits
        ? 'Lander workspace edit access'
        : 'Lander workspace read-only access',
    )}`,
    `extends=${tomlString(baseProfile)}`,
    ...(allowEdits
      ? [
          `workspace_roots={${tomlString(path.resolve(projectRoot))}=true}`,
          `filesystem={${filesystemRules}}`,
        ]
      : []),
    'network={enabled=true,allow_local_binding=true}',
  ].join(',')

  return [
    `default_permissions=${tomlString(profileId)}`,
    `permissions.${profileId}={${profileValue}}`,
  ]
}

function resolveGitCommonDirWithGit(cwd: string): string | undefined {
  try {
    const commonDir = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return commonDir ? path.resolve(cwd, commonDir) : undefined
  } catch {
    return undefined
  }
}

export function codexOptionsFromEnv(env: {
  LANDER_CODEX_PROFILE?: string | undefined
  LANDER_CODEX_CONFIG?: string | undefined
}): Pick<CodexFlowDeps, 'profile' | 'configOverrides'> {
  const profile = env.LANDER_CODEX_PROFILE?.trim() || undefined
  const configOverrides =
    env.LANDER_CODEX_CONFIG?.split('\n')
      .map((line) => line.trim())
      .filter(Boolean) ?? []
  return {
    ...(profile ? { profile } : {}),
    ...(configOverrides.length ? { configOverrides } : {}),
  }
}

function codexConfigArgs(
  profile: string | undefined,
  configOverrides: string[],
): string[] {
  return [
    ...(profile ? ['--profile', profile] : []),
    ...configOverrides.flatMap((entry) => ['--config', entry]),
  ]
}

function codexShellEnvConfigOverrides(): string[] {
  // Let Lander vars flow from the child process env so LANDER_TOKEN stays out of
  // argv. This stays a CLI config quirk, not a host-side env filter — scrubbing
  // the spawn env is a later step.
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

// Where codex launches its next turn. Pure, and called by the DAEMON pre-host.
export function resolveLaunchDir({
  root,
  recordedCwd,
  isDir,
}: {
  root: string
  recordedCwd?: string
  worktree?: string
  isDir(p: string): boolean
}): { cwd: string; reentryArgs: string[]; effectiveCwd?: string } {
  // Codex has no worktree flag: it resumes from the cwd the previous turn ended
  // in (relayed as --cd), falling back to root when that cwd is missing, gone, or
  // already root. Its writable sandbox is pinned to the project root independent
  // of --cd, so a wandered cwd never loses project access.
  const cwd =
    recordedCwd && recordedCwd !== root && isDir(recordedCwd) ? recordedCwd : root
  return { cwd, reentryArgs: [] }
}
