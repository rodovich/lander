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
    grants: { task: false, project: false },
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
  const str = (k: string) =>
    params && typeof params[k] === 'string' ? (params[k] as string) : ''
  const primary =
    str('AbsolutePath') ||
    str('TargetFile') ||
    str('DirectoryPath') ||
    str('NotebookPath') ||
    str('CommandLine') ||
    str('Pattern') ||
    str('Query') ||
    str('query') ||
    str('Url') ||
    str('SearchPath') ||
    str('SearchDirectory')
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
}: {
  taskPromptTemplate: string
  readProjectDoc: (dir: string) => string | undefined
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
      const dirs = new Set(['/tmp'])
      if (process.env.TMPDIR) dirs.add(process.env.TMPDIR)
      if (ctx.turn.filesDir && ctx.turn.filesDirExists) dirs.add(ctx.turn.filesDir)
      const child = ctx.spawn('agy', [
        '-p', prompt, '--output-format', 'stream-json', '--print-timeout', '0s',
        '--dangerously-skip-permissions',
        ...(sessionId ? ['--conversation', sessionId] : []),
        ...[...dirs].flatMap((dir) => ['--add-dir', dir]),
      ], {
        cwd: ctx.task.cwd,
        env: {
          ...ctx.task.env,
          ...(ctx.turn.filesDir ? { LANDER_FILES_DIR: ctx.turn.filesDir } : {}),
          ...(ctx.turn.run ? { LANDER_RUN: ctx.turn.run } : {}),
        },
      })
      const tools = new Map<number, ToolHandle>()
      const texts = new Map<number, string>()
      const seenUsageSteps = new Set<number>()
      const priorTotal: Usage | undefined = sessionId
        ? readThreadUsage(ctx.state.get(['threadUsage']))
        : { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }
      let liveUsage: Usage | undefined
      let pendingText: number | undefined
      let lastText = ''
      let announced = sessionId !== undefined
      let producedOutput = false
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
          if (event.step_type === 'agent_response') {
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
            let handle = tools.get(event.step_index)
            if (!handle) {
              handle = ctx.emit.tool({
                name: event.tool_name ?? info?.name ?? 'tool',
                ...formatToolCall(event),
              })
              tools.set(event.step_index, handle)
            }
            if (event.state !== 'ACTIVE') {
              const rawOutput = info?.output ?? info?.error?.message
              handle.result({
                ...(rawOutput !== undefined
                  ? { output: summarizeToolResult(rawOutput) }
                  : {}),
                isError: event.state === 'ERROR' || !!info?.error,
              })
            }
          }
        } else if (envelope.event === 'result') {
          const streamedFinal = pendingText !== undefined
            ? texts.get(pendingText) : undefined
          const response = event.response ?? streamedFinal ?? lastText
          if (pendingText !== undefined && streamedFinal === response) flushText()
          else {
            pendingText = undefined
            if (response) ctx.emit.message(response)
          }
          ctx.emit.reply(response)
          if (response) producedOutput = true
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
      if (producedOutput) {
        if (sendTaskPrompt) ctx.state.set(['taskPrompt'], digest)
        if (sendDoc && docDigest !== undefined) ctx.state.set(['landerDoc'], docDigest)
      }
      const exitCode = await child.exit
      await collectStderr
      return {
        exitCode: exitCode === 0 && terminalError ? 1 : exitCode,
        stderr: [stderr.trim(), terminalError].filter(Boolean).join('\n'),
      }
    },
  }
}

export function resolveLaunchDir({
  root, recordedCwd, isDir,
}: AgentLaunchDirInput): AgentLaunchDir {
  return { cwd: recordedCwd && recordedCwd !== root && isDir(recordedCwd) ? recordedCwd : root }
}
