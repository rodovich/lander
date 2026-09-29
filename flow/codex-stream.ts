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
  // The thread's running token total as of this turn, from `turn.completed`.
  // Not the turn's own usage: Codex builds that event from the thread total and
  // seeds it from the session file on resume (confirmed v0.154.0; v0.149–0.153
  // lost the seed to a bug and briefly reported per-turn counts). The flow
  // charges the turn its difference from the previous total — see
  // codexTurnUsage.
  threadUsage?: Usage
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
  let threadUsage: Usage | undefined
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
          // Codex reports every command wrapped in its login shell
          // (`/bin/zsh -lc '…'`); the chip shows the command the agent wrote.
          const shown = unwrapShellCommand(command)
          // A multi-line or long command reads on the chip as one clipped line;
          // keep the untruncated, newline-preserving form so the expanded chip can
          // show it as written. Omit it when the one-line summary already says as
          // much (a short single-line command).
          const inputFull = fullToolInput({ command: shown })
          steps.push({
            kind: 'tool_use',
            tool,
            input: shown,
            ...(inputFull && inputFull !== summarizeToolInput({ command: shown })
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
      } else if (item.type === 'file_change') {
        const id = typeof item.id === 'string' ? item.id : undefined
        const tool = item.type
        if (ev.type === 'item.started') {
          const path = firstChangePath(item)
          steps.push({
            kind: 'tool_use',
            tool,
            input: summarizeFileChange(item),
            toolUseId: id,
            rule: path ? toolRule(tool, { path }) : tool,
            createdAt: at,
          })
        } else {
          // The stream carries no diff or message for a patch, only its outcome.
          steps.push({
            kind: 'tool_result',
            text: '',
            toolUseId: id,
            isError: itemFailed(ev.type, item),
            createdAt: at,
          })
        }
      } else if (item.type === 'mcp_tool_call') {
        // Named by the item's own `tool` field, with its `server` leading the
        // input the way an Agent chip leads with its subagent type.
        const id = typeof item.id === 'string' ? item.id : undefined
        const tool = typeof item.tool === 'string' && item.tool ? item.tool : item.type
        const server = typeof item.server === 'string' ? item.server : ''
        if (ev.type === 'item.started') {
          const args = summarizeToolInput(item.arguments)
          const input = server ? (args ? `${server}: ${args}` : server) : args
          const argsFull = fullToolInput(item.arguments)
          const inputFull = server && argsFull ? `${server}: ${argsFull}` : argsFull
          steps.push({
            kind: 'tool_use',
            tool,
            input,
            ...(inputFull && inputFull !== input ? { inputFull } : {}),
            toolUseId: id,
            rule: toolRule(tool, item.arguments),
            createdAt: at,
          })
        } else {
          const error =
            item.error && typeof item.error === 'object'
              ? errorMessage(item.error)
              : undefined
          steps.push({
            kind: 'tool_result',
            text: summarizeToolResult(error ?? mcpResultContent(item.result)),
            toolUseId: id,
            isError: error !== undefined || itemFailed(ev.type, item),
            createdAt: at,
          })
        }
      } else if (item.type === 'web_search') {
        // The start carries an empty query (Codex fills it in on completion), so
        // the chip opens and settles at completion. Nothing else can land
        // between the two: the model sees the result before it writes again.
        if (ev.type !== 'item.started') {
          const id = typeof item.id === 'string' ? item.id : undefined
          const tool = item.type
          const query =
            (typeof item.query === 'string' && item.query) ||
            (typeof item.action?.query === 'string' ? item.action.query : '')
          steps.push({
            kind: 'tool_use',
            tool,
            input: query,
            toolUseId: id,
            rule: toolRule(tool, { query }),
            createdAt: at,
          })
          steps.push({
            kind: 'tool_result',
            text: '',
            toolUseId: id,
            isError: itemFailed(ev.type, item),
            createdAt: at,
          })
        }
      } else if (item.type === 'collab_tool_call') {
        // A multi-agent call, named by the item's own `tool` field. As of Codex
        // 0.154 only `wait` reaches the public stream, and with its receivers
        // and agent states empty — so the chip marks when the agent waited on
        // its subagents and nothing about them.
        const id = typeof item.id === 'string' ? item.id : undefined
        const tool = typeof item.tool === 'string' && item.tool ? item.tool : item.type
        if (ev.type === 'item.started') {
          steps.push({
            kind: 'tool_use',
            tool,
            input: '',
            toolUseId: id,
            rule: tool,
            createdAt: at,
          })
        } else {
          steps.push({
            kind: 'tool_result',
            text: '',
            toolUseId: id,
            isError: itemFailed(ev.type, item),
            createdAt: at,
          })
        }
      }
    }
  } else if (ev.type === 'turn.completed') {
    if (ev.usage && typeof ev.usage === 'object')
      threadUsage = parseCodexUsage(ev.usage as Record<string, unknown>)
  } else if (ev.type === 'error') {
    terminalError = errorMessage(ev)
  } else if (ev.type === 'turn.failed') {
    terminalError = errorMessage(ev.error) ?? errorMessage(ev)
  }

  return { steps, finalText, threadUsage, terminalError }
}

const USAGE_COUNTS = ['input', 'output', 'cacheRead', 'cacheCreation'] as const

// A turn's own usage, from the thread total its turn.completed reported and the
// previous turn's (`prior`: zeros for a fresh thread, undefined when resuming a
// thread whose previous total was never recorded). Returns undefined when the
// turn's share can't be known.
export function codexTurnUsage(
  now: Usage,
  prior: Usage | undefined,
): Usage | undefined {
  if (!prior) return undefined
  // A count that went backwards means Codex started the thread's total over, so
  // everything it reports is this turn's.
  if (USAGE_COUNTS.some((k) => now[k] < prior[k])) return now
  return {
    input: now.input - prior.input,
    output: now.output - prior.output,
    cacheRead: now.cacheRead - prior.cacheRead,
    cacheCreation: now.cacheCreation - prior.cacheCreation,
  }
}

// A thread total saved in flow state, or undefined when the value isn't one.
export function readThreadUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (!USAGE_COUNTS.every((k) => typeof v[k] === 'number')) return undefined
  return {
    input: v.input as number,
    output: v.output as number,
    cacheRead: v.cacheRead as number,
    cacheCreation: v.cacheCreation as number,
  }
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

// A settled item's outcome: `item.failed`, or a completion whose status says
// the call did not succeed.
function itemFailed(evType: string, item: Record<string, unknown>): boolean {
  return (
    evType === 'item.failed' ||
    item.status === 'failed' ||
    item.status === 'error'
  )
}

// An MCP call's result as Codex relays it: the server's `content` blocks.
function mcpResultContent(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  return (result as Record<string, unknown>).content
}

// The command inside Codex's login-shell wrapper — `/bin/zsh -lc '…'` — undoing
// the wrapper's quoting. Returned unchanged when it is not exactly that shape,
// so an unfamiliar form reads as Codex sent it rather than half-unwrapped.
export function unwrapShellCommand(command: string): string {
  const m = /^\/\S*\/(?:ba|z)?sh -lc (.+)$/s.exec(command)
  if (!m) return command
  const body = m[1]
  let out = ''
  let i = 0
  while (i < body.length) {
    const c = body[i]
    if (c === "'") {
      const end = body.indexOf("'", i + 1)
      if (end === -1) return command
      out += body.slice(i + 1, end)
      i = end + 1
    } else if (c === '"') {
      i++
      for (;;) {
        if (i >= body.length) return command
        const d = body[i]
        if (d === '"') break
        // Inside double quotes a backslash escapes only these four; before any
        // other character it is literal.
        if (d === '\\' && i + 1 < body.length && '"\\$`'.includes(body[i + 1])) {
          out += body[i + 1]
          i += 2
        } else {
          out += d
          i++
        }
      }
      i++
    } else if (c === '\\' && i + 1 < body.length) {
      out += body[i + 1]
      i += 2
    } else if (/\s/.test(c)) {
      // An unquoted space would make it several arguments, not one command.
      return command
    } else {
      out += c
      i++
    }
  }
  return out
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
