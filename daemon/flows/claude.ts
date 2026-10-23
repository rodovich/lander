// Claude task driver: assemble context and argv, run the CLI, and emit its turn.

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  addUsage,
  backgroundWait,
  checkoutNote,
  fillTaskPrompt,
  gitContext as realGitContext,
  projectDocBlock,
  reduceStreamLine,
  sessionCost,
  type SessionTotals,
  type Usage,
} from 'lander/flow'
import { fetchUsage, usageStatus, type UsageStatus } from '../../server/usage'
import type { Ctx, FlowMeta, GroupHandle, ToolHandle, TurnResult } from './ctx'
import type { AgentLaunchDir, AgentLaunchDirInput } from '../agent'

export const meta: FlowMeta = {
  api: 1,
  name: 'claude',
  description: 'Drive a task as a Claude Code conversation',
  driver: true,
  capabilities: {
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

// The CLI keeps the turn's process waiting on a background command and wakes
// the agent when it ends, and the daemon's idle watchdog allows for the wait.
// Without this note, an agent given an hour-long suite detached it instead.
const LONG_COMMAND_TIPS = [
  '# Long-running commands',
  '- Run a command that may take more than a few minutes (a test suite, build or benchmark) with Bash `run_in_background: true`, its output sent to a file, and a `timeout` (ms) that covers the whole run. The command is stopped at its timeout: the default is 30 minutes, the maximum 2 hours. Split longer work into pieces.',
  "- Then end your turn instead of waiting, polling or monitoring. You are woken in this session when the command finishes or is stopped; until then the task shows as working and new messages wait.",
  '- Don\'t detach a command (`nohup`, `&`, or spawning it from a script) to get around this: lander can neither stop it nor wake you when it ends.',
].join('\n')

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
      const sendContext = block !== '' && (!resuming || block !== baseline)
      if (sendContext) ctx.state.set(['turnContext'], block)

      // ── Prompt ───────────────────────────────────────────────────────────
      // The extras ride at the cache-friendly end, after the user's own text.
      // The revival notice goes here and not in the context block above: that
      // block is delta-compared against a stored baseline, so a one-turn line in
      // it would cost a spurious full resend next turn.
      const promptParts = [ctx.turn.prompts.join('\n\n')]
      if (ctx.turn.manifestBlock) promptParts.push(ctx.turn.manifestBlock)
      if (ctx.turn.revivedBlock) promptParts.push(ctx.turn.revivedBlock)
      if (ctx.turn.scheduledRideBlock) promptParts.push(ctx.turn.scheduledRideBlock)
      if (sendContext) promptParts.push(block)

      const args = [
        ...sessionArgs,
        ...buildClaudeArgs(ctx, promptParts.join('\n\n'), {
          landerBin,
          taskPromptTemplate,
          // Read from the task's checkout when it has one, so it gets its own
          // branch's conventions rather than the main checkout's; falls back to
          // root when there is none there. Deliberately NOT stateful: this
          // channel is request-scoped, so an edit takes effect on the next turn
          // with nothing to remember.
          projectDoc:
            (ctx.task.checkout !== undefined
              ? readProjectDoc(ctx.task.checkout)
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
      // The token counts of every result event so far. One process can report
      // several: a background task finishing after the turn's result wakes the
      // model again, and each result counts only its own model turns.
      let resultsUsage: Usage | undefined
      let usageInf: string | undefined
      // The session's running totals as of the previous turn, which this turn's
      // cost is the difference from. A fresh session starts from zero; a resumed
      // one whose previous totals were never recorded has no baseline. A turn
      // killed before its result leaves the baseline behind, so its cost lands
      // on the next turn rather than going uncounted.
      const priorTotals: SessionTotals | undefined = resuming
        ? readSessionTotals(ctx.state.get(['sessionTotals']))
        : { costUsd: 0, tokens: 0 }
      let stderrText = ''
      let apiError: string | undefined
      const waitingUntil = backgroundWait()

      const collectStderr = (async () => {
        for await (const l of child.stderr) stderrText += `${l}\n`
      })()

      for await (const line of child.lines()) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const r = reduceStreamLine(trimmed, ctx.now())

        if (r.turnStarted) ctx.emit.committed()
        if (r.apiError) apiError = r.apiError
        ctx.emit.waiting(waitingUntil(r, Date.parse(ctx.now())))
        if (r.drivingModel) ctx.emit.meter({ drivingModel: r.drivingModel })
        // Claude reports a reliable reset time, so the scheduled-retry option is
        // safe to arm from it (meta.capabilities.rateLimitRetry). The retry ask
        // itself stays a platform ask, raised server-side.
        if (r.rateLimitResetsAt)
          ctx.emit.meter({ rateLimitResetsAt: r.rateLimitResetsAt })

        for (const step of r.steps) {
          if (step.kind === 'context') {
            if (step.context) ctx.emit.context(step.context)
          } else if (step.kind === 'tool_use') {
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
            resultsUsage = addUsage(resultsUsage, r.usage)
            usage = usage?.cacheMiss
              ? { ...resultsUsage, cacheMiss: usage.cacheMiss }
              : resultsUsage
            if (r.sessionTotals) {
              const costUsd = sessionCost(r.sessionTotals, priorTotals, usage)
              usage = {
                ...usage,
                ...(costUsd !== undefined ? { costUsd } : {}),
                sessionCostUsd: r.sessionTotals.costUsd,
              }
              ctx.state.set(['sessionTotals'], r.sessionTotals)
            }
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
        exitCode,
        // The API error leads: the retry ask quotes the first line, and the
        // CLI's own stderr can open with a terse machine-formatted diagnostic.
        stderr: [apiError, stderrText.trim()].filter(Boolean).join('\n'),
      }
    },
  }
}

function readSessionTotals(v: unknown): SessionTotals | undefined {
  const t = v as Partial<SessionTotals> | undefined
  return typeof t?.costUsd === 'number' && typeof t.tokens === 'number'
    ? { costUsd: t.costUsd, tokens: t.tokens }
    : undefined
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
// the whole cached prefix. Empty when there is no state to report.
function buildContextBlock(
  ctx: Ctx,
  gitContext: (cwd: string) => string | undefined,
): string {
  const parts: string[] = []
  // The rules granted to this task, which ride --allowedTools. Listed as state
  // rather than as a "newly granted" note, so a grant surfaces exactly once — by
  // changing the block, which the baseline compare then re-sends — and a
  // one-turn line never costs a second resend when it drops out.
  if (ctx.task.allow?.length)
    parts.push(
      'Tool permissions granted to this task (beyond the defaults): ' +
        ctx.task.allow.map((rule) => `\`${rule}\``).join(', '),
    )
  // Read from where the shell starts — the task's checkout, when it has one.
  const landed = ctx.task.cwd
  const git = gitContext(landed)
  if (git) parts.push(git)
  // The last turn's shell ended somewhere other than where this one launches.
  // Fires only when the two differ.
  //
  // In a lander-managed checkout it fires only for a dir inside the checkout.
  // One outside it is where the task worked before it had a checkout — the
  // root, for a task adopted into one — and pointing back there would send it
  // out of its checkout.
  if (
    ctx.task.recordedCwd &&
    ctx.task.recordedCwd !== landed &&
    (!ctx.task.checkout || isInside(ctx.task.checkout, ctx.task.recordedCwd))
  )
    parts.push(manualCdHint(ctx.task.root, ctx.task.recordedCwd))
  if (!parts.length) return ''
  return [
    '<task-context>',
    'Task state as of this message — background context from lander, not ' +
      "the user's words. Re-sent only when it changes.",
    '',
    parts.join('\n\n'),
    '</task-context>',
  ].join('\n')
}

// Whether `p` is strictly below `dir`.
function isInside(dir: string, p: string): boolean {
  const rel = path.relative(dir, p)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// Deliberately silent on HOW: whether a location carries into the next turn
// depends on how the agent got there (a plain `cd` doesn't; Claude restores a
// worktree it entered itself), and that has changed under us before.
function manualCdHint(root: string, recordedCwd: string): string {
  const rel = path.relative(root, recordedCwd) || 'the project root'
  return (
    `Note: your previous turn ended in ${rel}. Depending how you moved there, ` +
    'that location may or may not have been preserved in this new turn. Check ' +
    '`pwd` before relying on the location.'
  )
}

const SELF_SCHEDULING_TOOLS = ['ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList']

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
  // Shared scratch roots. Agents reach for /tmp constantly for probe scripts and
  // diff dumps; without it they burn turns getting blocked and then route around
  // the block anyway. Grant BOTH the literal /tmp and os.tmpdir() — on macOS
  // those differ, so granting only one leaves the other blocked. Deduped for
  // Linux, where they're the same path, and existence-filtered because --add-dir
  // rejects a non-directory.
  const scratchRoots = [...new Set(['/tmp', tmpdir()])].filter((dir) =>
    existsSync(dir),
  )
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
      Stop: [{ hooks: [{ type: 'command', command: `${landerBin} record-cwd` }] }],
    },
  })

  return [
    // Edit access rides on --permission-mode acceptEdits rather than an
    // --allowedTools grant. An Edit/Write allow rule is "explicit permission", so
    // it escapes the working-directory boundary entirely (a granted Write can
    // create /tmp/anything); acceptEdits instead auto-approves file edits and the
    // filesystem Bash commands (mkdir/touch/rm/rmdir/mv/cp/sed) only for paths in
    // the cwd or an --add-dir root, and never for protected paths (.git, .claude).
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    ...allowed,
    // Claude's own scheduling tools act only while the turn's process lives, and
    // the CLI keeps that process alive, silent, until a pending wakeup fires —
    // so a wakeup further out than the idle window holds the task "working"
    // until the watchdog stops the run. `lander ride` schedules the same wake
    // outside the process.
    '--disallowedTools',
    ...SELF_SCHEDULING_TOOLS,
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
      fillTaskPrompt(taskPromptTemplate, ctx.task.taskId),
      GIT_TIPS,
      LONG_COMMAND_TIPS,
      ...(ctx.task.checkout ? [checkoutNote(ctx.task.checkout, ctx.task.root)] : []),
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
export function resolveLaunchDir({ root }: AgentLaunchDirInput): AgentLaunchDir {
  // This flow launches every turn at the project root. Nothing in the CLI asks
  // for that — `claude` runs wherever it is spawned — but the dir it is spawned
  // in *becomes* its permission boundary and config-load root, so choosing the
  // root here is what holds those fixed instead of letting them follow the agent
  // around. (A project that enables worktrees launches in the task's checkout
  // instead; the daemon decides that before this is consulted.)
  //
  // recordedCwd is deliberately ignored: a manual `cd` last turn does not become
  // this turn's root. Honoring it would make one stray cd permanent — the Stop
  // hook records where the shell ended and the launch would read it back, with
  // nothing in the loop to ever move it home again.
  return { cwd: root }
}

// The other out-of-turn hook, and the reason the global usage panel's content
// can leave the daemon core. The daemon keeps the SCHEDULE (60s TTL floor,
// per-turn trigger, boot/connect fetch, re-arming from refreshAt) because that
// schedule runs when no run — and therefore no host — is alive; the flow owns
// what a snapshot is: the credential read, the fetch, the item mapping, and when
// to look again. Codex exports none of this, so its panel stays empty.
export async function onStatus(): Promise<UsageStatus | null> {
  const r = await fetchUsage()
  return r.ok ? usageStatus(r.body) : null
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
