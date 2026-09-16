import {
  fullToolInput,
  summarizeToolInput,
  summarizeToolResult,
  toolRule,
  type Step,
  type Usage,
} from '../server/stream'

export type CodexLineUpdate = {
  steps: Step[]
  finalText?: string
  blockedIds?: string[]
  usage?: Usage
  usageInferenceId?: string
  usageFinal?: boolean
  drivingModel?: string
  rateLimitResetsAt?: string
  terminalError?: string
}

export function extractCodexSession(line: string): string | undefined {
  const ev = parseJson(line)
  if (ev?.type !== 'thread.started') return undefined
  if (typeof ev.thread_id === 'string') return ev.thread_id
  if (typeof ev.thread?.id === 'string') return ev.thread.id
  return undefined
}

export function reduceCodexStreamLine(
  line: string,
  at: string,
): CodexLineUpdate {
  const ev = parseJson(line)
  if (!ev) return { steps: [] }

  const steps: CodexLineUpdate['steps'] = []
  let finalText: string | undefined
  let usage: Usage | undefined
  let usageFinal: boolean | undefined
  let terminalError: string | undefined

  if (ev.type === 'item.started' || ev.type === 'item.completed' || ev.type === 'item.failed') {
    const item = ev.item
    if (item && typeof item === 'object') {
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        steps.push({ kind: 'text', text: item.text, createdAt: at })
        finalText = item.text
      } else if (item.type === 'command_execution') {
        const id = typeof item.id === 'string' ? item.id : undefined
        const tool = item.type
        const command = typeof item.command === 'string' ? item.command : ''
        if (ev.type === 'item.started') {
          // A multi-line or long command reads on the chip as one clipped line;
          // keep the untruncated, newline-preserving form so the expanded chip can
          // show it as written. Omit it when the one-line summary already says as
          // much (a short single-line command).
          const inputFull = fullToolInput({ command })
          steps.push({
            kind: 'tool_use',
            tool,
            input: command,
            ...(inputFull && inputFull !== summarizeToolInput({ command })
              ? { inputFull }
              : {}),
            toolUseId: id,
            rule: toolRule(tool, { command }),
            createdAt: at,
          })
        } else {
          steps.push({
            kind: 'tool_result',
            text: summarizeToolResult(commandOutput(item)),
            toolUseId: id,
            isError: commandFailed(item) || ev.type === 'item.failed',
            createdAt: at,
          })
        }
      } else if (item.type === 'file_change' && ev.type === 'item.started') {
        const id = typeof item.id === 'string' ? item.id : undefined
        const tool = item.type
        const path = firstChangePath(item)
        steps.push({
          kind: 'tool_use',
          tool,
          input: summarizeFileChange(item),
          toolUseId: id,
          rule: path ? toolRule(tool, { path }) : tool,
          createdAt: at,
        })
      }
    }
  } else if (ev.type === 'turn.completed') {
    if (ev.usage && typeof ev.usage === 'object') {
      usage = parseCodexUsage(ev.usage as Record<string, unknown>)
      usageFinal = true
    }
  } else if (ev.type === 'error') {
    terminalError = errorMessage(ev)
  } else if (ev.type === 'turn.failed') {
    terminalError = errorMessage(ev.error) ?? errorMessage(ev)
  }

  return { steps, finalText, usage, usageFinal, terminalError }
}

function parseJson(line: string): any | undefined {
  try {
    return JSON.parse(line)
  } catch {
    return undefined
  }
}

function parseCodexUsage(u: Record<string, unknown>): Usage {
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0)
  const totalInput = n('input_tokens') || n('prompt_tokens')
  const cacheRead = n('cached_input_tokens') || n('cache_read_input_tokens')
  const cacheCreation =
    n('cache_creation_input_tokens') || n('cache_creation_tokens')
  return {
    input: Math.max(totalInput - cacheRead - cacheCreation, 0),
    output: n('output_tokens') || n('completion_tokens'),
    cacheRead,
    cacheCreation,
  }
}

function commandOutput(item: Record<string, unknown>): string {
  const parts = [
    item.aggregated_output,
    item.output,
    item.stdout,
    item.stderr,
    item.message,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0)
  return parts.join(parts.length > 1 ? '\n' : '')
}

function commandFailed(item: Record<string, unknown>): boolean {
  if (item.status === 'failed' || item.status === 'error') return true
  if (typeof item.exit_code === 'number') return item.exit_code !== 0
  if (typeof item.exitCode === 'number') return item.exitCode !== 0
  return false
}

function firstChangePath(item: Record<string, unknown>): string | undefined {
  if (typeof item.path === 'string') return item.path
  if (typeof item.file_path === 'string') return item.file_path
  const changes = Array.isArray(item.changes) ? item.changes : []
  for (const change of changes) {
    if (!change || typeof change !== 'object') continue
    const c = change as Record<string, unknown>
    if (typeof c.path === 'string') return c.path
    if (typeof c.file_path === 'string') return c.file_path
  }
  return undefined
}

function summarizeFileChange(item: Record<string, unknown>): string {
  const changes = Array.isArray(item.changes) ? item.changes : []
  const first =
    changes.find((c) => c && typeof c === 'object') as
      | Record<string, unknown>
      | undefined
  const path = firstChangePath(item)
  const kind =
    (typeof first?.kind === 'string' && first.kind) ||
    (typeof item.kind === 'string' && item.kind) ||
    (typeof first?.type === 'string' && first.type) ||
    (typeof item.status === 'string' && item.status) ||
    ''
  return [kind, path].filter(Boolean).join(' ')
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return parseNestedError(value) ?? value
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  const message =
    (typeof v.message === 'string' && v.message) ||
    (typeof v.error === 'string' && v.error) ||
    (v.error && typeof v.error === 'object'
      ? errorMessage(v.error as Record<string, unknown>)
      : undefined)
  if (message) return parseNestedError(message) ?? message
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function parseNestedError(message: string): string | undefined {
  try {
    const parsed = JSON.parse(message)
    return errorMessage(parsed)
  } catch {
    return undefined
  }
}
