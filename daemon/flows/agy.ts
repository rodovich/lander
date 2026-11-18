import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  addUsage,
  codexTurnUsage,
  diffEdits,
  fullToolInput,
  prepareUserMessagePrompt,
  readThreadUsage,
  summarizeToolInput,
  summarizeToolResult,
  type Usage,
} from 'lander/flow'
import type { AgentLaunchDir, AgentLaunchDirInput } from '../agent'
import type { Ctx, FlowMeta, GroupHandle, ToolHandle, TurnResult } from './ctx'
import type { ContextUpdate } from '../../shared/context'
import {
  usageStatus,
  type UsageBody,
  type UsageStatus,
  type UsageWindow,
} from '../../server/usage'

const execFileAsync = promisify(execFile)

export const meta: FlowMeta = {
  api: 1,
  name: 'agy',
  description: 'Antigravity coding agent',
  driver: true,
  capabilities: {
    grants: {
      task: false,
      project: true,
      placeholder: 'e.g. command(git)',
    },
    usageSnapshot: true,
    rateLimitRetry: true,
    reportsCost: false,
  },
}

type AgySubagent = {
  type_name?: string
  role?: string
}

type AgyEvent = {
  conversation_id?: string
  step_index: number
  step_type?: string
  state?: string
  duration_seconds?: number
  text_delta?: string
  tool_name?: string
  tool_info?: {
    name?: string
    parameters?: unknown
    output?: string
    error?: { message?: string }
  }
  subagent_info?: {
    subagents?: AgySubagent[]
  }
  denied_actions?: {
    action?: string
    display_name?: string
  }[]
  usage?: unknown
  model?: string
  response?: string
  status?: string
  error?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function paramStr(
  params: Record<string, unknown> | undefined,
  ...keys: string[]
): string {
  if (!params) return ''
  for (const k of keys) {
    const v = params[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return ''
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

export function agyProjectId(projectPath: string): string {
  const hash = createHash('sha256')
    .update(canonicalPath(projectPath))
    .digest('hex')
    .slice(0, 16)
  return `lander-${hash}`
}

const DEFAULT_GEMINI_CONFIG_DIR = path.join(homedir(), '.gemini', 'config')

export function agyProjectFile(
  projectPath: string,
  geminiConfigDir = DEFAULT_GEMINI_CONFIG_DIR,
): string {
  return path.join(geminiConfigDir, 'projects', `${agyProjectId(projectPath)}.json`)
}

// agy's command(<prefix>) matcher checks literal command prefix rather than
// globs (except command(*)), so normalize Claude-style `command(git *)` or
// `command(git:*)` edits from the grant popup into `command(git)`.
export function normalizeAgyRule(rule: string): string {
  const trimmed = rule.trim()
  const m = /^command\((.+)\)$/.exec(trimmed)
  if (!m) return trimmed
  const inner = m[1].trim()
  if (inner === '*') return 'command(*)'
  const stripped = inner.replace(/(?:\s+\*|\:\*)$/, '').trim()
  return `command(${stripped || inner})`
}

function ensureAgyProjectRules(
  projectPath: string,
  rules: string[],
  geminiConfigDir = DEFAULT_GEMINI_CONFIG_DIR,
): string {
  const canonical = canonicalPath(projectPath)
  const projectId = agyProjectId(canonical)
  const file = agyProjectFile(canonical, geminiConfigDir)
  let doc: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (asRecord(parsed)) doc = parsed
  } catch {}
  doc.id = projectId
  doc.name ??= path.basename(canonical) || projectId
  doc.projectResources ??= {}
  const outer = (doc.permissionGrants = asRecord(doc.permissionGrants) ?? {})
  const inner = (outer.permissionGrants =
    asRecord(outer.permissionGrants) ?? {})
  const allow = Array.isArray(inner.allow)
    ? inner.allow.filter((r): r is string => typeof r === 'string')
    : []
  inner.allow = allow
  for (const rawRule of ['command(lander)', ...rules]) {
    const r = normalizeAgyRule(rawRule)
    if (r && !allow.includes(r)) allow.push(r)
  }
  outer.v2Migrated = true
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
  return projectId
}

const WRITE_FILE_TOOLS = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
  'notebook_edit',
])

const READ_FILE_TOOLS = new Set([
  'view_file',
  'list_dir',
  'grep_search',
  'find_by_name',
])

// When agy marks a refused call at all, it does so in the step's error text:
// "Action denied by user." or "permission check failed for unsandboxed …: user
// denied permission to run command …". A call stopped mid-run fails with
// "context canceled".
function isAgyDenial(message: string | undefined): boolean {
  return /user denied permission|action denied/i.test(message ?? '')
}

// `denied_actions` names only the action kind, so when the stream reports a
// refused call as a plain DONE, or the call was a subagent's, the debug log is
// the only record of which call agy refused.
export function agyLogRefusals(log: string): { conversation: string; step: number; at: number }[] {
  return [...log.matchAll(/^[IWEF](\d{4} [\d:.]+) .*Tool confirmation for conversation (\S+) step (\d+) \([^)]*approved=false\)/gm)]
    .map((m) => ({ conversation: m[2], step: Number(m[3]), at: glogTime(m[1]) }))
}

// glog stamps a line with local month, day and time but no year:
// "1110 12:34:03.332264".
function glogTime(stamp: string): number {
  const [, month, day, h, min, s, frac] = /^(\d\d)(\d\d) (\d\d):(\d\d):(\d\d)\.(\d+)$/.exec(stamp) ?? []
  const now = new Date()
  const at = (year: number) =>
    new Date(year, Number(month) - 1, Number(day), Number(h), Number(min), Number(s), Number(frac?.slice(0, 3).padEnd(3, '0'))).getTime()
  const sameYear = at(now.getFullYear())
  return sameYear > now.getTime() + 86_400_000 ? at(now.getFullYear() - 1) : sameYear
}

// `init` names the model only when `--model` was passed. Otherwise the debug log
// is the only record of it, as the display label ("Gemini 4 Argon (Medium)")
// rather than the slug, which can't be derived from the label.
export function agyLogModel(log: string): string | undefined {
  return /Propagating selected model override to backend: label="([^"]+)"/.exec(log)?.[1]
}

function agyErrorStep(stderr: string): number | undefined {
  const m = /^AGY_ERROR:.*"error_id":"[0-9a-f-]{36}-(\d+)(?:-\d+)?"/m.exec(stderr)
  return m ? Number(m[1]) : undefined
}

// agy streams a command's result only as the text it gives the model, so the
// exit code has to be read out of it.
const COMMAND_RESULT =
  /^(?:The tool's output was truncated[^\n]*\n\nHere is a preview[^\n]*\n)?(?:Created At: [^\n]*\n)?(?:Completed At: [^\n]*\n)?Command exited with code (\d+)\.\n\n(?:No output from the command\.|Command output:\n([\s\S]*))$/

function agyCommandResult(text: string): { exitCode: number; output: string } | undefined {
  const m = COMMAND_RESULT.exec(text)
  return m ? { exitCode: Number(m[1]), output: m[2] ?? '' } : undefined
}

function readFileIfPresent(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

function agyToolRule(
  event: AgyEvent,
): { action: string; rule: string } | undefined {
  const name = event.tool_name ?? event.tool_info?.name ?? ''
  const params = asRecord(event.tool_info?.parameters)
  const rule = (action: string, target: string) =>
    target ? { action, rule: `${action}(${target})` } : undefined
  if (name === 'run_command') {
    return rule('command', paramStr(params, 'CommandLine'))
  }
  if (WRITE_FILE_TOOLS.has(name)) {
    return rule(
      'write_file',
      paramStr(params, 'TargetFile', 'AbsolutePath', 'NotebookPath'),
    )
  }
  if (READ_FILE_TOOLS.has(name)) {
    return rule(
      'read_file',
      paramStr(
        params,
        'AbsolutePath',
        'DirectoryPath',
        'SearchPath',
        'SearchDirectory',
      ),
    )
  }
  if (name === 'read_url_content') {
    const rawUrl = paramStr(params, 'Url')
    return rule('read_url', URL.parse(rawUrl)?.hostname || rawUrl)
  }
  if (name === 'call_mcp_tool') {
    const server = paramStr(params, 'ServerName')
    const tool = paramStr(params, 'ToolName')
    return rule('mcp', server && tool ? `${server}:${tool}` : server)
  }
  return undefined
}

function summarizeAndFull(
  summaryInput: unknown,
  fullInput: unknown = summaryInput,
): { input: string; inputFull?: string } {
  const input = summarizeToolInput(summaryInput)
  const inputFull = fullToolInput(fullInput)
  return {
    input,
    ...(inputFull && inputFull !== input ? { inputFull } : {}),
  }
}

function formatSubagents(
  event: AgyEvent,
  params: Record<string, unknown> | undefined,
): { input: string; inputFull?: string } | undefined {
  const subInfo = Array.isArray(event.subagent_info?.subagents)
    ? event.subagent_info.subagents
    : []
  const paramSubs = Array.isArray(params?.Subagents) ? params.Subagents : []
  const count = Math.max(subInfo.length, paramSubs.length)
  if (!count) return undefined
  const heads: string[] = []
  const fullBlocks: string[] = []
  for (let i = 0; i < count; i++) {
    const s = subInfo[i]
    const p = asRecord(paramSubs[i])
    const type =
      (typeof s?.type_name === 'string' && s.type_name) ||
      (typeof p?.TypeName === 'string' && p.TypeName) ||
      ''
    const role =
      (typeof s?.role === 'string' && s.role) ||
      (typeof p?.Role === 'string' && p.Role) ||
      ''
    const prompt = typeof p?.Prompt === 'string' ? p.Prompt : ''
    const head = type && role ? `${type}: ${role}` : type || role
    if (head) heads.push(head)
    const block = head && prompt ? `${head}\n\n${prompt}` : head || prompt
    if (block) fullBlocks.push(block)
  }
  if (!heads.length) return undefined
  return summarizeAndFull(
    { description: heads.join(', ') },
    { description: fullBlocks.join('\n\n') },
  )
}

function extractEdits(
  params: Record<string, unknown> | undefined,
): { old: string; new: string }[] | undefined {
  if (!params) return undefined
  if (Array.isArray(params.ReplacementChunks)) {
    const edits = diffEdits('MultiEdit', {
      edits: params.ReplacementChunks.map((c) => {
        const chunk = asRecord(c)
        return chunk
          ? {
              old_string: chunk.TargetContent,
              new_string: chunk.ReplacementContent,
            }
          : c
      }),
    })
    return edits?.length ? edits : undefined
  }
  return diffEdits('Edit', {
    old_string: params.TargetContent,
    new_string: params.ReplacementContent,
  })
}

function formatToolCall(event: AgyEvent): {
  input: string
  inputFull?: string
  edits?: { old: string; new: string }[]
} {
  const params = asRecord(event.tool_info?.parameters)
  const sub = formatSubagents(event, params)
  if (sub) return sub
  const primary = paramStr(
    params,
    'AbsolutePath',
    'TargetFile',
    'DirectoryPath',
    'NotebookPath',
    'CommandLine',
    'Pattern',
    'Query',
    'query',
    'Url',
    'SearchPath',
    'SearchDirectory',
  )
  const normalized = primary ? { description: primary } : params
  const edits = extractEdits(params)
  return {
    ...summarizeAndFull(normalized),
    ...(edits ? { edits } : {}),
  }
}

function parseAgyUsage(raw: unknown): Usage | undefined {
  const u = asRecord(raw)
  if (
    !u ||
    (typeof u.input_tokens !== 'number' &&
      typeof u.output_tokens !== 'number' &&
      typeof u.cache_read_tokens !== 'number')
  )
    return undefined
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0)
  return {
    input: n('input_tokens'),
    output: n('output_tokens'),
    cacheRead: n('cache_read_tokens'),
    cacheCreation: 0,
  }
}

export function makeFlow({
  taskPromptTemplate,
  readProjectDoc,
  geminiConfigDir,
  readAgyLog = readFileIfPresent,
  readCliVersion,
}: {
  taskPromptTemplate: string
  readProjectDoc: (dir: string) => string | undefined
  geminiConfigDir?: string
  readAgyLog?: (file: string) => string | undefined
  // The installed agy's version, for the ride's record.
  readCliVersion?: () => Promise<string | undefined>
}) {
  return {
    meta,
    async onTurn(ctx: Ctx): Promise<TurnResult> {
      const version = readCliVersion?.()
      const known = ctx.state.get(['sessionId'])
      const sessionId = typeof known === 'string' && known ? known : undefined
      const { prompt, commitDelivered } = prepareUserMessagePrompt(ctx, {
        sessionId,
        taskPromptTemplate,
        readProjectDoc,
      })
      const projectId = ensureAgyProjectRules(ctx.task.root, [], geminiConfigDir)
      const dirs = new Set<string>()
      const addDir = (dir: string | undefined) => {
        if (!dir) return
        dirs.add(dir)
        dirs.add(canonicalPath(dir))
      }
      addDir('/tmp')
      addDir(process.env.TMPDIR)
      if (ctx.turn.filesDir && ctx.turn.filesDirExists) addDir(ctx.turn.filesDir)
      const priorTotal = sessionId
        ? readThreadUsage(ctx.state.get(['threadUsage']))
        : { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
      let conversation = sessionId
      let message = prompt
      let liveUsage: Usage | undefined
      const cliVersion = version && await version
      if (cliVersion) ctx.emit.meter({ cliVersion })
      for (let first = true; ; first = false) {
        const run = await runAgy(ctx, [
          '-p', message, '--output-format', 'stream-json', '--print-timeout', '0s',
          '--mode', 'accept-edits', '--project', projectId,
          ...(conversation ? ['--conversation', conversation] : []),
          ...[...dirs].flatMap((dir) => ['--add-dir', dir]),
        ], { sessionId: conversation, priorTotal, liveUsage, readLog: readAgyLog })
        if (run.lostConversation)
          return { exitCode: 1, stderr: run.stderr.trim(), cause: 'session-lost' }
        if (first && run.producedOutput) commitDelivered()
        // agy ends the turn at a call no rule covers instead of letting the
        // agent carry on without it, so tell the agent and let it choose.
        if (run.refusals.length > 0 && !run.terminalError && !ctx.signal.aborted && run.conversationId) {
          conversation = run.conversationId
          message = agyRepromptMessage(run.refusals)
          liveUsage = run.liveUsage
          ctx.emit.reprompt(message)
          continue
        }
        return {
          exitCode: run.exitCode === 0 && run.terminalError ? 1 : run.exitCode,
          stderr: [run.stderr.trim(), run.terminalError].filter(Boolean).join('\n'),
        }
      }
    },
  }
}

// One refused call, as far as lander can identify it. `seen` is set when the
// call's own result already told the agent it was refused.
export type AgyRefusal =
  | { in: 'turn'; tool: string; input: string; seen: boolean }
  | { in: 'subagent'; action: string; conversation: string }
  | { in: 'unknown'; action: string }

// What the agent can't see for itself: that agy ended its turn, and what lander
// knows of each refusal its own results don't report.
export function agyRepromptMessage(refusals: AgyRefusal[]): string {
  const n = refusals.length
  const one = n === 1
  const opening = refusals.every((r) => r.in === 'subagent')
    ? 'Your turn ended after Antigravity refused'
    : 'Antigravity ended your turn because it refused'
  const lines = [
    `[lander] ${opening} ${one ? 'a call' : `${n} calls`} needing a permission the user has not granted.` +
      ` No allow rule covered ${one ? 'that call' : 'those calls'}; your goal may still be fine.` +
      ` You may reach it with a command the user has already allowed for that purpose, but not by running ${one ? 'the' : 'a'} refused command through another shell, interpreter, script, or wrapper.`,
  ]
  for (const r of refusals) {
    if (r.in === 'turn' && !r.seen)
      lines.push(`- Your ${r.tool} call \`${r.input}\` was refused. Its result says it was canceled.`)
    else if (r.in === 'subagent')
      lines.push(`- A ${r.action} call by your subagent (conversation ${r.conversation}) was refused.`)
    else if (r.in === 'unknown')
      lines.push(`- Antigravity did not say which ${r.action} call it refused.`)
  }
  return lines.join('\n')
}

type AgyRun = {
  exitCode: number
  stderr: string
  terminalError?: string
  refusals: AgyRefusal[]
  producedOutput: boolean
  conversationId?: string
  liveUsage?: Usage
  lostConversation?: boolean
}

type RunOpts = {
  sessionId: string | undefined
  priorTotal: Usage | undefined
  liveUsage: Usage | undefined
}

async function runAgy(
  ctx: Ctx,
  args: string[],
  { readLog, ...opts }: RunOpts & { readLog: (file: string) => string | undefined },
): Promise<AgyRun> {
  // The log carries the user's account email, so it outlives the process only
  // long enough to be read.
  const logDir = mkdtempSync(path.join(tmpdir(), 'lander-agy-'))
  const logFile = path.join(logDir, 'agy.log')
  try {
    return await reduceAgy(ctx, [...args, '--log-file', logFile], {
      ...opts, readRunLog: () => readLog(logFile),
    })
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
}

async function reduceAgy(
  ctx: Ctx,
  args: string[],
  { sessionId, priorTotal, liveUsage: startUsage, readRunLog }: RunOpts & {
    readRunLog: () => string | undefined
  },
): Promise<AgyRun> {
  const child = ctx.spawn('agy', args, {
    cwd: ctx.task.cwd,
    env: {
      ...ctx.task.env,
      ...(ctx.turn.filesDir ? { LANDER_FILES_DIR: ctx.turn.filesDir } : {}),
      ...(ctx.turn.run ? { LANDER_RUN: ctx.turn.run } : {}),
    },
  })
  const tools = new Map<
    number,
    {
      handle: ToolHandle
      name: string
      input: string
      action?: string
      denied?: boolean
      blocked?: boolean
    }
  >()
  const texts = new Map<number, string>()
  // Each agent_response step is one model call, and the tool steps after it are
  // the calls it made, so a response's step index marks one inference.
  const responseGroups = new Map<number, GroupHandle>()
  let responseGroup: GroupHandle | undefined
  const seenUsageSteps = new Set<number>()
  const seenCheckpoints = new Set<number>()
  const savedContextTokens = sessionId ? ctx.state.get(['contextTokens']) : undefined
  let contextTokens = typeof savedContextTokens === 'number' ? savedContextTokens : undefined
  let pendingCheckpoint: ContextUpdate | undefined
  let liveUsage = startUsage
  let pendingText: number | undefined
  let lastText = ''
  let conversationId = sessionId
  let awaitingResumedId = sessionId !== undefined
  let producedOutput = false
  let lastStepDone = false
  let maxStep = -1
  let lastToolAt = -Infinity
  let deniedActions: NonNullable<AgyEvent['denied_actions']> = []
  let terminalError: string | undefined
  let stderr = ''
  const collectStderr = (async () => {
    for await (const line of child.stderr) stderr += `${line}\n`
  })()
  const flushCheckpoint = (afterTokens?: number) => {
    if (!pendingCheckpoint) return
    ctx.emit.context({
      ...pendingCheckpoint,
      ...(afterTokens !== undefined ? { afterTokens } : {}),
    })
    pendingCheckpoint = undefined
  }
  const flushText = () => {
    if (pendingText !== undefined) {
      flushCheckpoint()
      const text = texts.get(pendingText) ?? ''
      if (text) {
        lastText = text
        ctx.emit.message(text, { group: responseGroups.get(pendingText) })
      }
      pendingText = undefined
    }
  }
  for await (const line of child.lines()) {
    if (!line.trim()) continue
    let envelope: AgyEvent & {
      event: string
      init?: { model?: string }
      step_update?: AgyEvent
      result?: AgyEvent
    }
    try {
      envelope = JSON.parse(line)
    } catch {
      continue
    }
    if (!envelope || typeof envelope !== 'object') continue
    const event = envelope.event === 'step_update'
      ? envelope.step_update
      : envelope.event === 'result' ? envelope.result : envelope
    if (!event) continue
    if (typeof event.conversation_id === 'string' && event.conversation_id) {
      // agy answers a --conversation id it can't find by starting a new
      // conversation, saying so only on stderr. Stop it as soon as the new id
      // shows, so the agent doesn't work on without the history.
      if (awaitingResumedId && event.conversation_id !== sessionId) {
        child.kill()
        const exitCode = await child.exit
        await collectStderr
        return { exitCode, stderr, refusals: [], producedOutput: false, lostConversation: true }
      }
      awaitingResumedId = false
      if (event.conversation_id !== conversationId) {
        conversationId = event.conversation_id
        ctx.state.set(['sessionId'], conversationId)
      }
    }
    if (
      envelope.event === 'init' &&
      typeof envelope.init?.model === 'string' &&
      envelope.init.model
    ) {
      ctx.emit.meter({ drivingModel: envelope.init.model })
    } else if (envelope.event === 'step_update') {
      lastStepDone = event.state === 'DONE'
      if (typeof event.step_index === 'number')
        maxStep = Math.max(maxStep, event.step_index)
      if (event.step_type === 'checkpoint') {
        if (event.state === 'DONE' && !seenCheckpoints.has(event.step_index)) {
          flushText()
          flushCheckpoint()
          seenCheckpoints.add(event.step_index)
          const seconds = event.duration_seconds
          pendingCheckpoint = {
            action: 'checkpoint',
            phase: 'completed',
            ...(contextTokens !== undefined ? { beforeTokens: contextTokens } : {}),
            ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
              ? { durationMs: seconds * 1000 }
              : {}),
          }
          contextTokens = undefined
          ctx.state.delete(['contextTokens'])
        }
      } else if (event.step_type === 'agent_response') {
        if (pendingText !== event.step_index) flushText()
        pendingText = event.step_index
        responseGroup = responseGroups.get(event.step_index)
        if (!responseGroup)
          responseGroups.set(event.step_index, (responseGroup = ctx.emit.group()))
        texts.set(
          event.step_index,
          (texts.get(event.step_index) ?? '') + (event.text_delta ?? ''),
        )
        const stepUsage = parseAgyUsage(event.usage)
        if (stepUsage && !seenUsageSteps.has(event.step_index)) {
          seenUsageSteps.add(event.step_index)
          contextTokens = stepUsage.input + stepUsage.cacheRead
          ctx.state.set(['contextTokens'], contextTokens)
          flushCheckpoint(contextTokens)
          liveUsage = addUsage(liveUsage, stepUsage)
          ctx.emit.meter({ usage: liveUsage })
        }
        if (event.text_delta || stepUsage) producedOutput = true
      } else if (event.step_type === 'tool') {
        flushCheckpoint()
        flushText()
        producedOutput = true
        const info = event.tool_info
        let entry = tools.get(event.step_index)
        if (!entry) {
          const ruleInfo = agyToolRule(event)
          const name = event.tool_name ?? info?.name ?? 'tool'
          const call = formatToolCall(event)
          const handle = ctx.emit.tool({
            name,
            ...call,
            ...(ruleInfo ? { rule: ruleInfo.rule } : {}),
            group: responseGroup,
          })
          entry = { handle, name, input: call.input, action: ruleInfo?.action }
          tools.set(event.step_index, entry)
        }
        lastToolAt = Date.now()
        if (event.state !== 'ACTIVE') {
          const command = entry.name === 'run_command' && info?.output !== undefined
            ? agyCommandResult(info.output)
            : undefined
          const rawOutput = command
            ? (command.exitCode ? `Exit code ${command.exitCode}\n${command.output}` : command.output) || undefined
            : info?.output ?? info?.error?.message
          const isError = event.state === 'ERROR' || !!info?.error || !!command?.exitCode
          entry.denied = isError && isAgyDenial(info?.error?.message)
          entry.handle.result({
            ...(rawOutput !== undefined
              ? { output: summarizeToolResult(rawOutput) }
              : {}),
            isError,
          })
        }
      }
    } else if (envelope.event === 'result') {
      flushCheckpoint()
      flushText()
      if (Array.isArray(event.denied_actions)) deniedActions = event.denied_actions
      if (!lastText && event.response) {
        lastText = event.response
        ctx.emit.message(event.response)
      }
      if (lastText) {
        ctx.emit.reply(lastText)
        producedOutput = true
      }
      const totalUsage = parseAgyUsage(event.usage)
      if (totalUsage) {
        const usage = codexTurnUsage(totalUsage, priorTotal)
        if (usage) {
          liveUsage = usage
          ctx.emit.meter({ usage })
        }
        ctx.state.set(['threadUsage'], totalUsage)
      }
      if (event.status !== 'SUCCESS') {
        terminalError = event.error ||
          `Antigravity turn failed (${event.status ?? 'unknown status'}).`
      }
    }
  }
  flushCheckpoint()
  flushText()
  const exitCode = await child.exit
  await collectStderr
  const log = readRunLog() ?? ''
  const loggedModel = agyLogModel(log)
  // The server stamps the model onto a ride only in an update that carries usage.
  if (loggedModel) ctx.emit.meter({ drivingModel: loggedModel, usage: liveUsage })
  // agy repeats any ERROR_MESSAGE step from the conversation's history in
  // every later result and in AGY_ERROR on stderr.
  const errorStep = agyErrorStep(stderr)
  if (
    exitCode === 0
      ? lastStepDone
      : errorStep !== undefined && errorStep < maxStep
  ) {
    terminalError = undefined
  }
  const refusals: AgyRefusal[] = []
  if (deniedActions.length) {
    const logged = agyLogRefusals(log)
    const refusedSteps = new Set(
      logged.filter((r) => r.conversation === conversationId).map((r) => r.step),
    )
    const subagents = logged.filter((r) => r.conversation !== conversationId)
    const recorded = [...tools].reverse()
    for (const denied of deniedActions) {
      const action =
        typeof denied?.action === 'string' ? denied.action : undefined
      const name = denied?.display_name ?? action ?? 'tool'
      const target = recorded.find(([step, t]) =>
        !t.blocked && t.action === action && (t.denied || refusedSteps.has(step)),
      )?.[1]
      const subagent = target ? undefined : subagents.shift()
      if (target) {
        target.blocked = true
        target.handle.result({ blocked: true })
        refusals.push({ in: 'turn', tool: target.name, input: target.input, seen: !!target.denied })
      } else if (subagent) {
        ctx.emit.notice(`Antigravity refused a ${name} call in a subagent.`)
        // agy lists a subagent's refusal in the turn's result even when the
        // parent kept working after it.
        if (subagent.at > lastToolAt)
          refusals.push({ in: 'subagent', action: name, conversation: subagent.conversation })
      } else {
        ctx.emit.notice(
          `Antigravity denied a ${name} call this turn without saying which one.`,
        )
        refusals.push({ in: 'unknown', action: name })
      }
    }
  }
  return {
    exitCode,
    stderr,
    terminalError,
    refusals,
    producedOutput,
    conversationId,
    liveUsage,
  }
}

export async function onGrant(
  _ctx: unknown,
  {
    projectPath,
    rule,
    geminiConfigDir,
  }: { projectPath: string; rule: string; geminiConfigDir?: string },
): Promise<void> {
  ensureAgyProjectRules(projectPath, [rule], geminiConfigDir)
}

export function agyUsageBody(output: unknown): UsageBody | null {
  const groups = asRecord(asRecord(asRecord(output)?.command)?.data)?.groups
  if (!Array.isArray(groups)) return null
  const buckets = groups.flatMap((g) => {
    const b = asRecord(g)?.buckets
    return Array.isArray(b) ? b.map(asRecord) : []
  })
  const window = (id: string): UsageWindow | null => {
    const b = buckets.find((b) => b?.id === id)
    if (typeof b?.remaining_fraction !== 'number') return null
    return {
      utilization: (1 - b.remaining_fraction) * 100,
      resetsAt: typeof b.reset_time === 'string' ? b.reset_time : null,
    }
  }
  const body = { session: window('gemini-5h'), weekly: window('gemini-weekly') }
  return body.session || body.weekly ? body : null
}

const USAGE_TIMEOUT_MS = 30_000

export async function onStatus(): Promise<UsageStatus | null> {
  const { stdout } = await execFileAsync(
    'agy',
    ['-p', '/usage', '--output-format', 'json'],
    { timeout: USAGE_TIMEOUT_MS },
  )
  const body = agyUsageBody(JSON.parse(stdout))
  return body ? usageStatus(body) : null
}

export function resolveLaunchDir({
  root, recordedCwd, isDir,
}: AgentLaunchDirInput): AgentLaunchDir {
  return { cwd: recordedCwd && recordedCwd !== root && isDir(recordedCwd) ? recordedCwd : root }
}
