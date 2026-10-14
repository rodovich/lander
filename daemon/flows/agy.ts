import {
  checkoutNote,
  deliveryDigest,
  fillTaskPrompt,
  forwardableAccess,
  projectDocBlock,
  shouldDeliver,
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
  response?: string
  status?: string
  error?: string
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
      if (!ctx.task.allowEdits) return {
        exitCode: 1,
        stderr: 'agy tasks require edit permission (--edits); Antigravity CLI has no headless mode that permits running the lander CLI while enforcing read-only access.',
      }

      const known = ctx.state.get(['sessionId'])
      const sessionId = typeof known === 'string' && known ? known : undefined
      const taskPrompt = fillTaskPrompt(
        taskPromptTemplate,
        'Antigravity runs with --dangerously-skip-permissions. Edit access covers ' +
          'unrestricted file creation, editing, and deletion, including `.git` and ' +
          'paths outside the workspace, and all shell commands. ' +
          forwardableAccess(ctx.task),
        ctx.task.taskId,
      )
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
        if (envelope.event === 'step_update') {
          if (event.step_type === 'agent_response') {
            if (pendingText !== event.step_index) flushText()
            pendingText = event.step_index
            texts.set(
              event.step_index,
              (texts.get(event.step_index) ?? '') + (event.text_delta ?? ''),
            )
            if (event.text_delta) producedOutput = true
          } else if (event.step_type === 'tool') {
            flushText()
            producedOutput = true
            const info = event.tool_info
            let handle = tools.get(event.step_index)
            if (!handle) {
              handle = ctx.emit.tool({
                name: event.tool_name ?? info?.name ?? 'tool',
                input: JSON.stringify(info?.parameters ?? {}),
              })
              tools.set(event.step_index, handle)
            }
            if (event.state !== 'ACTIVE') handle.result({
              output: info?.output ?? info?.error?.message,
              isError: event.state === 'ERROR' || !!info?.error,
            })
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
