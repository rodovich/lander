// Codex as a driver flow. Shorter than claude's because codex carries less: no
// session minting (the thread id arrives in the stream), no per-turn context
// block, and no project grants or usage snapshot to own.
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
import { codexConfigArgs } from '../codex-config'
import { execFileSync } from 'node:child_process'
import {
  codexTurnUsage,
  deliveryDigest,
  extractCodexSession,
  projectDocBlock,
  readThreadUsage,
  reduceCodexStreamLine,
  shouldDeliver,
  checkoutNote,
  fillTaskPrompt,
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
}

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

      // ── Task prompt ──────────────────────────────────────────────────────
      // Codex has no request-scoped channel for lander's own prose (claude uses
      // --append-system-prompt), so this rides the user message — which means a
      // copy sent on one turn stays in that turn's message and replays on every
      // later one. Deliver it once per thread, and again only when the rendered
      // text changes: the digest is content-addressed, so a template edit or a
      // mid-task grant flip re-delivers the corrected text on the next turn
      // without any separate staleness machinery.
      //
      // The commit is deferred to after the read loop, gated on the turn having
      // produced output. See deliveryDigest/shouldDeliver for why that ordering
      // is the whole safety argument.
      const taskPrompt = fillTaskPrompt(
        taskPromptTemplate,
        codexForwardableText(ctx.task.allowEdits),
        ctx.task.taskId,
      )
      // The checkout note rides with it, so a task adopted into a checkout gets
      // it on its next turn through the digest change.
      const rendered = ctx.task.checkout
        ? `${taskPrompt}\n\n${checkoutNote(ctx.task.checkout, ctx.task.root)}`
        : taskPrompt
      const digest = deliveryDigest(rendered)
      const sendTaskPrompt = shouldDeliver(
        sessionId,
        ctx.state.get(['taskPrompt']),
        digest,
      )

      // ── Prompt ───────────────────────────────────────────────────────────
      const promptParts = [ctx.turn.prompts.join('\n\n')]
      if (ctx.turn.manifestBlock) promptParts.push(ctx.turn.manifestBlock)
      // Codex has no turn-context block to hide this in, which is half of why the
      // revival notice is part of the user prompt.
      if (ctx.turn.revivedBlock) promptParts.push(ctx.turn.revivedBlock)
      if (ctx.turn.scheduledRideBlock) promptParts.push(ctx.turn.scheduledRideBlock)
      // ── Project doc ──────────────────────────────────────────────────────
      // The project's optional LANDER.md, delivered through the same
      // deliver-once record as the task prompt but under its own key, because
      // the two change independently. Codex has no request-scoped channel, so
      // unlike claude — where this rides --append-system-prompt with no record
      // at all — it has to be tracked. Read from the tree the shell lands in,
      // falling back to root.
      const doc =
        (ctx.task.checkout !== undefined
          ? readProjectDoc(ctx.task.checkout)
          : undefined) ?? readProjectDoc(ctx.task.root)
      const docDigest = doc === undefined ? undefined : deliveryDigest(doc)
      const sendDoc =
        docDigest !== undefined &&
        shouldDeliver(sessionId, ctx.state.get(['landerDoc']), docDigest)

      // Both unshift, so the final order is: task prompt, project doc, user
      // text. Lander's own instructions precede the repo's, and the repo's
      // precede the user's — each layer able to be read in light of the one
      // before it.
      if (sendDoc && doc !== undefined) promptParts.unshift(projectDocBlock(doc))
      if (sendTaskPrompt) promptParts.unshift(rendered)

      const args = buildCodexArgs(ctx, promptParts.join('\n\n'), sessionId, {
        profile,
        configOverrides,
        gitDirs: ctx.task.allowEdits ? resolveGitDirs(ctx.task.cwd) : [],
      })

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
          if (usage) ctx.emit.meter({ usage })
          ctx.state.set(['threadUsage'], r.threadUsage)
        }
      }

      // Commit the delivery only now, and only if the model actually consumed
      // the turn. Written after the loop rather than inside it so the decision
      // sees the whole turn; runFlowTurn flushes state after onTurn returns, so
      // this still reaches the server. Non-throwing on purpose: a rejected state
      // write (oversize blob) must degrade to a duplicate next turn, never to a
      // failed turn.
      if (producedOutput) {
        try {
          if (sendTaskPrompt) ctx.state.set(['taskPrompt'], digest)
          // Separate key: an edit to one must not suppress the other.
          if (sendDoc && docDigest !== undefined)
            ctx.state.set(['landerDoc'], docDigest)
        } catch {
          // Deliberate: re-delivering is the benign direction.
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

// The reach of an edit grant under the permission profiles built below.
const EDIT_REACH =
  'Edit access covers creating, editing, and deleting files — through any ' +
  'tool or shell command, git included — within the project directory (or ' +
  "the task's own checkout, when it has one) and the scratch roots (`/tmp` " +
  'and `$TMPDIR`). Every shell command runs inside the same sandbox, so ' +
  'without edit access commands can read files but not change them.'

// The template's {{forwardable}} slot. "As of this message", not "this turn":
// a superseded copy of the template stays in the thread's append-only history,
// so the wording must not assert a fact about whichever turn happens to be
// reading it.
export function codexForwardableText(allowEdits: boolean): string {
  return (
    `${EDIT_REACH} ` +
    `As of this message, this task runs with the workspace-scoped ${
      allowEdits ? 'edit' : 'read-only'
    } permission profile. ` +
    'Task allow rules are stored by Lander but do not affect Codex runs yet'
  )
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
      ctx.task.allowEdits,
      ctx.task.checkout ?? ctx.task.root,
      gitDirs,
    ),
    ...codexShellEnvConfigOverrides(),
  ]
  // One `-i <path>` per image (the repeatable short form), then `--`, then the
  // prompt. Without the terminator a fresh `exec`'s variadic --image swallows a
  // trailing positional, so the flags must precede it. It also keeps a prompt
  // that begins with `-` out of argv parsing, which matters because a turn that
  // has already delivered the task prompt leads with the user's own text
  // (confirmed Codex v0.144.5: a bare `- bullet…` prompt errors with "unexpected
  // argument", and codex's own tip is to pass it after `--`).
  const imageArgs = ctx.turn.images.flatMap((p) => ['-i', p])
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
      ...imageArgs,
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
    ...imageArgs,
    '--',
    prompt,
  ]
}

// Edit access is a scoped permission profile, not a --sandbox mode: a synthesized
// `lander-edit` / `lander-read-only` profile pins the writable workspace to the
// resolved project root and spells out the .git rules.
function codexPermissionConfigOverrides(
  allowEdits: boolean,
  projectRoot: string,
  gitDirs: string[],
): string[] {
  const profileId = allowEdits ? 'lander-edit' : 'lander-read-only'
  const baseProfile = allowEdits ? ':workspace' : ':read-only'
  const filesystemRules = allowEdits
    ? [
        `${tomlString(':workspace_roots')}={${tomlEntry('.git', 'write')}}`,
        ...gitDirs.map((dir) => tomlEntry(path.resolve(dir), 'write')),
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
