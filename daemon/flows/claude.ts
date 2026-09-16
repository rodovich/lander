// Claude task driver: assemble context and argv, run the CLI, and emit its turn.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  addUsage,
  fillTaskPrompt,
  forwardableAccess,
  gitContext as realGitContext,
  projectDocBlock,
  reduceStreamLine,
  type Usage,
} from 'lander/flow'
import { fetchUsage, usageTelemetry } from '../../server/usage'
import type { TelemetryItem } from '../../server/protocol'
import type { Ctx, FlowMeta, GroupHandle, ToolHandle, TurnResult } from './ctx'

export const meta: FlowMeta = {
  api: 1,
  name: 'claude',
  description: 'Drive a task as a Claude Code conversation',
  driver: true,
  capabilities: {
    worktrees: true,
    // Claude has no vision flag on the CLI: it Reads an image by its local path,
    // which the manifest block words accordingly.
    vision: 'read',
    grants: { task: true, project: true },
    usageSnapshot: true,
    rateLimitRetry: true,
    // Claude's result event carries the turn's dollar cost.
    reportsCost: true,
  },
  inputs: {},
}

// Claude regenerates its default system prompt every invocation, and lander runs
// one `claude -p` process per turn — so anything dynamic in that prompt (the git
// status snapshot changes on any commit or file edit) busts the prompt cache for
// the entire conversation on the next turn. includeGitInstructions:false removes
// the snapshot along with the built-in git workflow instructions; the snapshot
// moves into the per-turn task-context block, and the instructions worth keeping
// return as static text below.
const GIT_TIPS = [
  '# Git',
  '- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.',
  '- Use the `gh` CLI for GitHub operations (PRs, issues, API).',
  '- Commit or push only when the user asks. If on the default branch, branch first.',
].join('\n')

// The static stand-in for the template's {{forwardable}} slot: the live grants
// sentence moved to the task-context block so the appended system prompt stays
// byte-stable across turns (see forwardableAccess / the context block below).
const FORWARDABLE_POINTER =
  'Your own current grants — which cap what you can forward — are stated in ' +
  'the task-context block in the conversation'

export type ClaudeFlowDeps = {
  landerBin: string
  taskPromptTemplate: string
  // Injectable so tests are deterministic and touch neither git nor crypto.
  gitContext?: (cwd: string) => string | undefined
  mint?: () => string
  // The project's optional LANDER.md. REQUIRED, with no default on purpose: a
  // default would make the transcript fixtures pass only because their fake root
  // happens not to exist on the host, which is how an earlier revision of this
  // was green by luck. Required makes every construction site decide.
  readProjectDoc: (dir: string) => string | undefined
}

export type ClaudeFlow = {
  meta: FlowMeta
  onTurn(ctx: Ctx): Promise<TurnResult>
}

export function makeFlow({
  landerBin,
  taskPromptTemplate,
  gitContext = realGitContext,
  mint = randomUUID,
  readProjectDoc,
}: ClaudeFlowDeps): ClaudeFlow {
  return {
    meta,
    async onTurn(ctx: Ctx): Promise<TurnResult> {
      // ── Session ──────────────────────────────────────────────────────────
      // The id is seeded from flowState, falling back to the legacy top-level
      // wire field for a task whose session predates the storage flip — without
      // that fallback a pre-flip task would mint fresh here and silently abandon
      // its conversation.
      const known = ctx.state.get(['sessionId'])
      const resuming = typeof known === 'string' && known.length > 0
      const sessionId = resuming ? (known as string) : mint()
      const sessionArgs = resuming
        ? ['--resume', sessionId]
        : ['--session-id', sessionId]
      // Written (and flushed) before the spawn, so a crash between here and the
      // first output cannot lose the identity of a session claude already has.
      if (!resuming) ctx.state.set(['sessionId'], sessionId)

      // ── Turn context ─────────────────────────────────────────────────────
      const block = buildContextBlock(ctx, gitContext)
      const baseline = ctx.state.get(['turnContext'])
      // A fresh session gets the full block unconditionally. The server withholds
      // the baseline when there is no session to resume, but flowState rides in
      // ungated and a replayed patch can outlive a seal — so a stale baseline
      // must never be able to suppress a new session's context.
      const sendContext = !resuming || block !== baseline
      if (sendContext) ctx.state.set(['turnContext'], block)

      // ── Prompt ───────────────────────────────────────────────────────────
      // The extras ride at the cache-friendly end, after the user's own text.
      // The revival notice goes here and not in the context block above: that
      // block is delta-compared against a stored baseline, so a one-turn line in
      // it would cost a spurious full resend next turn.
      const promptParts = [ctx.turn.prompts.join('\n\n')]
      if (ctx.turn.manifestBlock) promptParts.push(ctx.turn.manifestBlock)
      if (ctx.turn.revivedBlock) promptParts.push(ctx.turn.revivedBlock)
      if (sendContext) promptParts.push(block)

      const args = [
        ...sessionArgs,
        // The worktree re-entry argv rides right after the session args and
        // before the rest of the launch, which ends in `-- <prompt>` — so it must
        // precede that terminator, not trail it.
        ...ctx.task.reentryArgs,
        ...buildClaudeArgs(ctx, promptParts.join('\n\n'), {
          landerBin,
          taskPromptTemplate,
          // Read from the tree the shell actually lands in, so a worktree task
          // gets its own branch's conventions rather than the main checkout's;
          // falls back to root when there is no worktree or none is present
          // there. Deliberately NOT stateful: this channel is request-scoped, so
          // an edit takes effect on the next turn with nothing to remember.
          projectDoc:
            (ctx.task.effectiveCwd !== undefined
              ? readProjectDoc(ctx.task.effectiveCwd)
              : undefined) ?? readProjectDoc(ctx.task.root),
        }),
      ]

      const child = ctx.spawn('claude', args, {
        env: {
          ...ctx.task.env,
          // No existence gate: the daemon always supplies these, and `lander
          // attachment cat/ls` must reach a file attached on an earlier turn.
          // Only --add-dir is gated on the dir actually existing.
          ...(ctx.turn.filesDir
            ? { LANDER_FILES_DIR: ctx.turn.filesDir }
            : {}),
          ...(ctx.turn.run ? { LANDER_RUN: ctx.turn.run } : {}),
        },
      })

      // ── Reduce ───────────────────────────────────────────────────────────
      const tools = new Map<string, ToolHandle>()
      const groups = new Map<string, GroupHandle>()
      const groupFor = (id: string | undefined): GroupHandle | undefined => {
        if (id === undefined) return undefined
        let g = groups.get(id)
        if (!g) groups.set(id, (g = ctx.emit.group()))
        return g
      }

      let usage: Usage | undefined
      let usageInf: string | undefined
      let stderrText = ''

      const collectStderr = (async () => {
        for await (const l of child.stderr) stderrText += `${l}\n`
      })()

      for await (const line of child.lines()) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const r = reduceStreamLine(trimmed, ctx.now())

        if (r.drivingModel) ctx.emit.meter({ drivingModel: r.drivingModel })
        // Claude reports a reliable reset time, so the scheduled-retry option is
        // safe to arm from it (meta.capabilities.rateLimitRetry). The retry ask
        // itself stays a platform ask, raised server-side.
        if (r.rateLimitResetsAt)
          ctx.emit.meter({ rateLimitResetsAt: r.rateLimitResetsAt })
        // No terminal-error branch: claude's reducer has no such channel (unlike
        // codex's), so a failed turn reaches us as an exit code plus stderr. The
        // generic executor carries one for providers that do report errors
        // in-stream; here it would be unreachable code.

        for (const step of r.steps) {
          if (step.kind === 'tool_use') {
            const h = ctx.emit.tool({
              name: step.tool ?? '',
              input: step.input ?? '',
              ...(step.inputFull !== undefined
                ? { inputFull: step.inputFull }
                : {}),
              ...(step.rule !== undefined
                ? { rule: anchorFileRule(step.rule) }
                : {}),
              ...(step.edits !== undefined ? { edits: step.edits } : {}),
              ...(groupFor(step.inferenceId) !== undefined
                ? { group: groupFor(step.inferenceId) }
                : {}),
              ...(step.parentToolUseId !== undefined &&
              tools.get(step.parentToolUseId)
                ? { parent: tools.get(step.parentToolUseId) }
                : {}),
            })
            if (step.toolUseId !== undefined) tools.set(step.toolUseId, h)
          } else if (step.kind === 'text') {
            ctx.emit.message(step.text ?? '', {
              ...(groupFor(step.inferenceId) !== undefined
                ? { group: groupFor(step.inferenceId) }
                : {}),
              ...(step.parentToolUseId !== undefined &&
              tools.get(step.parentToolUseId)
                ? { parent: tools.get(step.parentToolUseId) }
                : {}),
            })
          } else {
            // A result whose call was never observed opening still has to land;
            // synthesize the open so the lifecycle is well-formed rather than
            // leaving an orphan for the server's fallback to adopt.
            const localId = step.toolUseId
            let h = localId !== undefined ? tools.get(localId) : undefined
            if (!h) {
              h = ctx.emit.tool({
                name: step.tool ?? '',
                input: step.input ?? '',
                ...(step.parentToolUseId !== undefined &&
                tools.get(step.parentToolUseId)
                  ? { parent: tools.get(step.parentToolUseId) }
                  : {}),
              })
              if (localId !== undefined) tools.set(localId, h)
            }
            h.result({
              ...(step.text !== undefined ? { output: step.text } : {}),
              ...(step.isError !== undefined ? { isError: step.isError } : {}),
            })
          }
        }

        // The turn's reply text carries no step of its own: an assistant text
        // block already emitted one, and the terminal result event's
        // authoritative reply would duplicate the message if it emitted another.
        if (r.finalText !== undefined) ctx.emit.reply(r.finalText)

        // Denials are named after the fact by the terminal result event, so they
        // fold onto calls emitted in an earlier batch.
        for (const deniedId of r.blockedIds ?? []) {
          const h = tools.get(deniedId)
          if (h) h.result({ blocked: true })
        }

        if (r.usage) {
          if (r.usageFinal) {
            // The result event's total is authoritative for the counts but
            // carries no diagnostics — keep the streamed cache-miss record.
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
      return { exitCode, stderr: stderrText.trim() }
    },
  }
}

// The tools whose permission rule takes a file path rather than a command or a
// query, so `Read(/x)` names a path while `Bash(/x)` names a command.
const FILE_RULE_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']

// Spell a denied call's rule the way Claude will match it once granted. Claude
// reads a single leading slash as anchored at whatever defined the rule — the
// project for settings.local.json, the cwd for --allowedTools — so a rule built
// from a tool call's absolute `file_path` matches nothing. `//` is the CLI's
// spelling for an absolute path.
//
// Applied here, where the rule is minted from the call, rather than when a grant
// is saved: a rule the user types or edits in the grant popup can mean a
// project-relative `/src/**` on purpose, while a call's own path cannot. Doing it
// once here also keeps the popup showing the rule the grant will save. Relative
// paths (a subagent can pass one) already resolve against the launch root, and
// pass through untouched.
export function anchorFileRule(rule: string): string {
  const match = /^([A-Za-z]+)\((\/[^/].*)\)$/.exec(rule)
  return match && FILE_RULE_TOOLS.includes(match[1])
    ? `${match[1]}(/${match[2]})`
    : rule
}

// The dynamic per-turn context block. Dynamic facts belong at the cache-friendly
// end of the conversation, not in the system prompt where any change invalidates
// the whole cached prefix.
function buildContextBlock(
  ctx: Ctx,
  gitContext: (cwd: string) => string | undefined,
): string {
  const parts = [`${forwardableAccess({ agent: 'claude', ...ctx.task })}.`]
  // A worktree task launches from the project root and re-enters the worktree
  // through argv, so read the snapshot from where the shell actually lands —
  // reading root would describe the wrong branch and dirty tree.
  const landed = ctx.task.effectiveCwd ?? ctx.task.cwd
  const git = gitContext(landed)
  if (git) parts.push(git)
  // A manual `cd` last turn recorded that dir as the task cwd, but this turn
  // launches at root and won't restore it. Fires only when the landed dir
  // differs; a worktree re-entry lands back where it was, so it stays silent.
  if (ctx.task.recordedCwd && ctx.task.recordedCwd !== landed)
    parts.push(
      manualCdHint(
        ctx.task.root,
        ctx.task.recordedCwd,
        landed,
        ctx.task.worktree,
      ),
    )
  return [
    '<task-context>',
    'Task state as of this message — background context from lander, not ' +
      "the user's words. Re-sent only when it changes.",
    '',
    parts.join('\n\n'),
    '</task-context>',
  ].join('\n')
}

// Whether a path sits inside `<root>/.claude/worktrees/`, where EnterWorktree
// roots the worktrees it creates — so a recorded cwd there is one the agent
// walked into itself, by name or by hand.
function insideWorktreesDir(root: string, p: string): boolean {
  const rel = path.relative(path.join(root, '.claude', 'worktrees'), p)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// When the recorded dir was inside a worktree and the task has none recorded,
// the note also names the tool that makes the return automatic. A `cd` lives
// only in the turn's own shell, while an EnterWorktree binding outlives it — so
// an agent working a worktree over several turns re-walks in every time, and
// lander, with nothing recorded, cannot show where it is.
function manualCdHint(
  root: string,
  recordedCwd: string,
  landed: string,
  worktree: string | undefined,
): string {
  const rel = (p: string) => path.relative(root, p) || 'the project root'
  const note =
    `Note: your previous turn's shell ended in ${rel(recordedCwd)}, but this ` +
    `turn starts at ${rel(landed)} (a manual cd isn't carried across turns) — ` +
    `cd back if you still need to work there.`
  if (worktree || !insideWorktreesDir(root, recordedCwd)) return note
  return (
    `${note} That is a git worktree you entered by hand. To keep working there ` +
    `across turns, enter it with EnterWorktree instead, passing the worktree's ` +
    "`path` — later turns then start inside it, and it shows against this task. " +
    'Entering by path borrows the worktree rather than owning it, so exiting ' +
    'will not remove it.'
  )
}

function buildClaudeArgs(
  ctx: Ctx,
  prompt: string,
  {
    landerBin,
    taskPromptTemplate,
    projectDoc,
  }: {
    landerBin: string
    taskPromptTemplate: string
    projectDoc?: string | undefined
  },
): string[] {
  // Extra workspace root for the materialized attachment store, so Read can open
  // an attached image sitting outside the task's cwd. Gated on the dir existing
  // — --add-dir rejects a path that isn't a directory.
  const filesDirArgs =
    ctx.turn.filesDir && ctx.turn.filesDirExists
      ? ['--add-dir', ctx.turn.filesDir]
      : []
  // Edit access rides on --permission-mode acceptEdits rather than an
  // --allowedTools grant. An Edit/Write allow rule is "explicit permission", so
  // it escapes the working-directory boundary entirely (a granted Write can
  // create /tmp/anything); acceptEdits instead auto-approves file edits and the
  // filesystem Bash commands (mkdir/touch/rm/rmdir/mv/cp/sed) only for paths in
  // the cwd or an --add-dir root, and never for protected paths (.git, .claude).
  const editModeArgs = ctx.task.allowEdits
    ? ['--permission-mode', 'acceptEdits']
    : []
  // Shared scratch roots. Agents reach for /tmp constantly for probe scripts and
  // diff dumps; without it they burn turns getting blocked and then route around
  // the block anyway. Grant BOTH the literal /tmp and os.tmpdir() — on macOS
  // those differ, so granting only one leaves the other blocked. Deduped for
  // Linux, where they're the same path, and existence-filtered because --add-dir
  // rejects a non-directory. In acceptEdits every --add-dir root is writable, so
  // gate on edit access.
  const scratchRoots = ctx.task.allowEdits
    ? [...new Set(['/tmp', tmpdir()])].filter((dir) => existsSync(dir))
    : []
  const tmpDirArgs = scratchRoots.flatMap((dir) => ['--add-dir', dir])
  const allowed: string[] = ['Bash(lander:*)']
  if (ctx.task.allow?.length) allowed.push(...ctx.task.allow)

  const hookSettings = JSON.stringify({
    // Keep the git status snapshot (and built-in git workflow instructions) out
    // of the regenerated-per-turn system prompt — see the note on GIT_TIPS.
    includeGitInstructions: false,
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `${landerBin} bash-guard` }],
        },
      ],
      PostToolUse: [
        {
          matcher: 'EnterWorktree',
          hooks: [{ type: 'command', command: `${landerBin} record-worktree` }],
        },
        {
          matcher: 'ExitWorktree',
          hooks: [{ type: 'command', command: `${landerBin} clear-worktree` }],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: `${landerBin} record-cwd` }] }],
    },
  })

  return [
    ...editModeArgs,
    '--allowedTools',
    ...allowed,
    ...filesDirArgs,
    ...tmpDirArgs,
    '--settings',
    hookSettings,
    '--append-system-prompt',
    // The project doc rides here rather than in the prompt because this string
    // is request-scoped: rebuilt every invocation, so one copy is present on
    // every turn, it tracks edits with no delivery record to keep, and it
    // survives compaction. It trails GIT_TIPS so lander's own instructions
    // precede the repo's. The cost is that a LANDER.md edit — or a branch switch
    // that changes it — busts this conversation's prompt cache, which is why
    // nothing else in this string is allowed to vary per turn.
    [
      fillTaskPrompt(taskPromptTemplate, FORWARDABLE_POINTER, ctx.task.taskId),
      GIT_TIPS,
      ...(projectDoc ? [projectDocBlock(projectDoc)] : []),
    ].join('\n\n'),
    '--output-format',
    'stream-json',
    '--verbose',
    '-p',
    '--',
    prompt,
  ]
}

// Where claude launches its next turn. Pure, and called by the DAEMON before the
// host spawns — it stats directories on the daemon host to decide the spawn cwd,
// which is why it is a module export rather than something onTurn does.
export function resolveLaunchDir({
  root,
  worktree,
}: {
  root: string
  recordedCwd?: string
  worktree?: string
  isDir(p: string): boolean
}): { cwd: string; reentryArgs: string[]; effectiveCwd?: string } {
  // This flow launches every turn at the project root. Nothing in the CLI asks
  // for that — `claude` runs wherever it is spawned — but the dir it is spawned
  // in *becomes* its permission boundary and config-load root, so choosing the
  // root here is what holds those fixed instead of letting them follow the agent
  // around. A worktree is re-entered through argv, landing the shell inside it
  // while the launch dir stays root.
  //
  // recordedCwd is deliberately ignored: a manual `cd` last turn does not become
  // this turn's root. Honoring it would make one stray cd permanent — the Stop
  // hook records where the shell ended and the launch would read it back, with
  // nothing in the loop to ever move it home again.
  if (worktree)
    return {
      cwd: root,
      reentryArgs: ['--worktree', worktree],
      effectiveCwd: path.join(root, '.claude', 'worktrees', worktree),
    }
  return { cwd: root, reentryArgs: [] }
}

// The other out-of-turn hook, and the reason the global usage panel's content
// can leave the daemon core. The daemon keeps the SCHEDULE (60s TTL floor,
// per-turn trigger, boot/connect fetch, re-arming from refreshAt) because that
// schedule runs when no run — and therefore no host — is alive; the flow owns
// what a snapshot is: the credential read, the fetch, the item mapping, and when
// to look again. Codex exports none of this, so its panel stays empty.
export async function onStatus(): Promise<{
  items: TelemetryItem[]
  refreshAt?: string
} | null> {
  const r = await fetchUsage()
  if (!r.ok) return null
  // The soonest window reset, nudged past the boundary so the readout catches
  // utilization dropping back. The daemon still clamps this against its TTL
  // floor — a reset already in the past must not become a busy loop.
  const resets = [r.body.session?.resetsAt, r.body.weekly?.resetsAt]
    .map((s) => (s ? Date.parse(s) : NaN))
    .filter((n) => Number.isFinite(n))
  return {
    items: usageTelemetry(r.body),
    ...(resets.length
      ? { refreshAt: new Date(Math.min(...resets) + 2_000).toISOString() }
      : {}),
  }
}

// An out-of-turn hook: a project grant arrives over the daemon WS with no run
// alive, so there is no host to route it through and the daemon calls this
// in-process.
export async function onGrant(
  _ctx: unknown,
  { projectPath, rule }: { projectPath: string; rule: string },
): Promise<void> {
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
