import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  addUsage,
  checkoutNote,
  codexTurnUsage,
  deliveryDigest,
  diffEdits,
  fillTaskPrompt,
  fullToolInput,
  projectDocBlock,
  readThreadUsage,
  shouldDeliver,
  summarizeToolInput,
  summarizeToolResult,
  type Usage,
} from 'lander/flow'
import type { AgentLaunchDir, AgentLaunchDirInput } from '../agent'
import type { Ctx, FlowMeta, ToolHandle, TurnResult } from './ctx'

export const meta: FlowMeta = {
  api: 1,
  name: 'agy',
  description: 'Antigravity coding agent',
  driver: true,
  capabilities: {
    vision: 'read',
    grants: { task: false, project: true },
    usageSnapshot: false,
    rateLimitRetry: false,
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
export function isAgyDenial(message: string | undefined): boolean {
  return /user denied permission|action denied/i.test(message ?? '')
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
}: {
  taskPromptTemplate: string
  readProjectDoc: (dir: string) => string | undefined
  geminiConfigDir?: string
}) {
  return {
    meta,
    async onTurn(ctx: Ctx): Promise<TurnResult> {
      const known = ctx.state.get(['sessionId'])
      const sessionId = typeof known === 'string' && known ? known : undefined
      const taskPrompt = fillTaskPrompt(taskPromptTemplate, ctx.task.taskId)
      const rendered = ctx.task.checkout
        ? `${taskPrompt}\n\n${checkoutNote(ctx.task.checkout, ctx.task.root)}`
        : taskPrompt
      const digest = deliveryDigest(rendered)
      const sendTaskPrompt = shouldDeliver(
        sessionId,
        ctx.state.get(['taskPrompt']),
        digest,
      )
      const doc =
        (ctx.task.checkout ? readProjectDoc(ctx.task.checkout) : undefined) ??
        readProjectDoc(ctx.task.root)
      const docDigest = doc === undefined ? undefined : deliveryDigest(doc)
      const sendDoc =
        docDigest !== undefined &&
        shouldDeliver(sessionId, ctx.state.get(['landerDoc']), docDigest)
      const prompt = [
        sendTaskPrompt ? rendered : undefined,
        sendDoc && doc !== undefined ? projectDocBlock(doc) : undefined,
        ctx.turn.prompts.join('\n\n'),
        ctx.turn.manifestBlock,
        ctx.turn.revivedBlock,
        ctx.turn.scheduledRideBlock,
      ].filter((part) => part !== undefined).join('\n\n')
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
      const run = await runAgy(ctx, [
        '-p', prompt, '--output-format', 'stream-json', '--print-timeout', '0s',
        '--mode', 'accept-edits', '--project', projectId,
        ...(sessionId ? ['--conversation', sessionId] : []),
        ...[...dirs].flatMap((dir) => ['--add-dir', dir]),
      ], {
        sessionId,
        priorTotal: sessionId
          ? readThreadUsage(ctx.state.get(['threadUsage']))
          : { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      })
      if (run.producedOutput) {
        if (sendTaskPrompt) ctx.state.set(['taskPrompt'], digest)
        if (sendDoc && docDigest !== undefined) ctx.state.set(['landerDoc'], docDigest)
      }
      if (run.permissionAborted && !run.terminalError && ctx.task.env.LANDER_API) {
        await ctx.wedge()
      }
      return {
        exitCode: run.exitCode === 0 && run.terminalError ? 1 : run.exitCode,
        stderr: [run.stderr.trim(), run.terminalError].filter(Boolean).join('\n'),
      }
    },
  }
}

type AgyRun = {
  exitCode: number
  stderr: string
  terminalError?: string
  permissionAborted: boolean
  producedOutput: boolean
}

async function runAgy(
  ctx: Ctx,
  args: string[],
  { sessionId, priorTotal }: { sessionId: string | undefined; priorTotal: Usage | undefined },
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
      action?: string
      denied?: boolean
      silent?: boolean
      blocked?: boolean
    }
  >()
  const texts = new Map<number, string>()
  const seenUsageSteps = new Set<number>()
  const seenCheckpoints = new Set<number>()
  let liveUsage: Usage | undefined
  let pendingText: number | undefined
  let lastText = ''
  let announced = sessionId !== undefined
  let producedOutput = false
  let permissionAborted = false
  let terminalError: string | undefined
  let stderr = ''
  const collectStderr = (async () => {
    for await (const line of child.stderr) stderr += `${line}\n`
  })()
  const flushText = () => {
    if (pendingText !== undefined) {
      lastText = texts.get(pendingText) ?? ''
      if (lastText) ctx.emit.message(lastText)
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
    if (
      !announced &&
      typeof event.conversation_id === 'string' &&
      event.conversation_id
    ) {
      ctx.state.set(['sessionId'], event.conversation_id)
      announced = true
    }
    if (
      envelope.event === 'init' &&
      typeof envelope.init?.model === 'string' &&
      envelope.init.model
    ) {
      ctx.emit.meter({ drivingModel: envelope.init.model })
    } else if (envelope.event === 'step_update') {
      if (event.step_type === 'checkpoint') {
        if (event.state === 'DONE' && !seenCheckpoints.has(event.step_index)) {
          flushText()
          seenCheckpoints.add(event.step_index)
          if (ctx.state.get(['landerDoc']) !== undefined)
            ctx.state.delete(['landerDoc'])
          const seconds = event.duration_seconds
          ctx.emit.context({
            action: 'checkpoint',
            phase: 'completed',
            ...(typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
              ? { durationMs: seconds * 1000 }
              : {}),
          })
        }
      } else if (event.step_type === 'agent_response') {
        if (pendingText !== event.step_index) flushText()
        pendingText = event.step_index
        texts.set(
          event.step_index,
          (texts.get(event.step_index) ?? '') + (event.text_delta ?? ''),
        )
        const stepUsage = parseAgyUsage(event.usage)
        if (stepUsage && !seenUsageSteps.has(event.step_index)) {
          seenUsageSteps.add(event.step_index)
          liveUsage = addUsage(liveUsage, stepUsage)
          ctx.emit.meter({ usage: liveUsage })
        }
        if (event.text_delta || stepUsage) producedOutput = true
      } else if (event.step_type === 'tool') {
        flushText()
        producedOutput = true
        const info = event.tool_info
        let entry = tools.get(event.step_index)
        if (!entry) {
          const ruleInfo = agyToolRule(event)
          const handle = ctx.emit.tool({
            name: event.tool_name ?? info?.name ?? 'tool',
            ...formatToolCall(event),
            ...(ruleInfo ? { rule: ruleInfo.rule } : {}),
          })
          entry = { handle, action: ruleInfo?.action }
          tools.set(event.step_index, entry)
        }
        if (event.state !== 'ACTIVE') {
          const rawOutput = info?.output ?? info?.error?.message
          const isError = event.state === 'ERROR' || !!info?.error
          entry.denied = isError && isAgyDenial(info?.error?.message)
          entry.silent = !isError && !info?.output
          entry.handle.result({
            ...(rawOutput !== undefined
              ? { output: summarizeToolResult(rawOutput) }
              : {}),
            isError,
          })
        }
      }
    } else if (envelope.event === 'result') {
      flushText()
      if (Array.isArray(event.denied_actions) && event.denied_actions.length > 0) {
        permissionAborted = true
        const recorded = [...tools.values()].reverse()
        for (const denied of event.denied_actions) {
          const action =
            typeof denied?.action === 'string' ? denied.action : undefined
          // A denial names only the action kind, and agy sometimes streams
          // a denied command as a plain DONE with no output instead of with
          // its denial error. That is also how an allowed command with no
          // output, or one queued behind the refusal, looks, so a silent
          // command is blamed only when it is the turn's sole one. Only
          // command denials have been probed.
          const open = action
            ? recorded.filter((t) => !t.blocked && t.action === action)
            : []
          const silent =
            action === 'command' ? open.filter((t) => t.silent) : []
          const target =
            open.find((t) => t.denied) ??
            (silent.length === 1 ? silent[0] : undefined)
          if (target) {
            target.blocked = true
            target.handle.result({ blocked: true })
          } else {
            ctx.emit.notice(
              `Antigravity denied a ${denied?.display_name ?? action ?? 'tool'} call this turn without saying which one.`,
            )
          }
        }
      }
      if (event.response && event.response !== lastText) {
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
        if (usage) ctx.emit.meter({ usage })
        ctx.state.set(['threadUsage'], totalUsage)
      }
      if (event.status !== 'SUCCESS') {
        terminalError = event.error ||
          `Antigravity turn failed (${event.status ?? 'unknown status'}).`
      }
    }
  }
  flushText()
  const exitCode = await child.exit
  await collectStderr
  return { exitCode, stderr, terminalError, permissionAborted, producedOutput }
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

export function resolveLaunchDir({
  root, recordedCwd, isDir,
}: AgentLaunchDirInput): AgentLaunchDir {
  return { cwd: recordedCwd && recordedCwd !== root && isDir(recordedCwd) ? recordedCwd : root }
}
