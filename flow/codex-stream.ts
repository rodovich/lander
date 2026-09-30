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
  // Set when the line is a Codex notice (an `error` item) rather than anything
  // the model did.
  notice?: true
}

export function extractCodexSession(line: string): string | undefined {
  const ev = parseJson(line)
  if (ev?.type !== 'thread.started') return undefined
  return typeof ev.thread_id === 'string' ? ev.thread_id : undefined
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
  let notice: true | undefined

  if (ev.type === 'item.started' || ev.type === 'item.completed') {
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
            text: summarizeToolResult(item.aggregated_output),
            toolUseId: id,
            // A declined command — its approval refused — also reports exit -1.
            isError:
              item.status === 'failed' ||
              item.status === 'declined' ||
              (typeof item.exit_code === 'number' && item.exit_code !== 0),
            createdAt: at,
          })
        }
      } else if (item.type === 'file_change') {
        const id = typeof item.id === 'string' ? item.id : undefined
        const tool = item.type
        const changes = fileChanges(item)
        if (ev.type === 'item.started') {
          steps.push({
            kind: 'tool_use',
            tool,
            input: changes.map((c) => `${c.kind} ${c.path}`).join(', '),
            toolUseId: id,
            rule: changes.length ? toolRule(tool, { path: changes[0].path }) : tool,
            createdAt: at,
          })
        } else {
          // The stream carries no diff or message for a patch, only its outcome.
          steps.push({
            kind: 'tool_result',
            text: '',
            toolUseId: id,
            isError: item.status === 'failed',
            createdAt: at,
          })
        }
      } else if (item.type === 'mcp_tool_call') {
        // The server and tool lead the input, the way an Agent chip leads with
        // its subagent type.
        const id = typeof item.id === 'string' ? item.id : undefined
        const tool = item.type
        if (ev.type === 'item.started') {
          const callee = [item.server, item.tool]
            .filter((v) => typeof v === 'string' && v)
            .join(' ')
          const args = summarizeToolInput(item.arguments)
          const input = args ? `${callee}: ${args}` : callee
          const argsFull = fullToolInput(item.arguments)
          const inputFull = argsFull ? `${callee}: ${argsFull}` : callee
          steps.push({
            kind: 'tool_use',
            tool,
            input,
            ...(inputFull !== input ? { inputFull } : {}),
            toolUseId: id,
            createdAt: at,
          })
        } else {
          const error =
            typeof item.error?.message === 'string' ? item.error.message : undefined
          steps.push({
            kind: 'tool_result',
            text: summarizeToolResult(error ?? item.result?.content),
            toolUseId: id,
            isError: item.status === 'failed',
            createdAt: at,
          })
        }
      } else if (item.type === 'web_search') {
        // The start carries an empty query and no action (Codex fills both in on
        // completion), so the chip opens and settles at completion. Nothing else
        // can land between the two: the model sees the result before it writes
        // again.
        if (ev.type === 'item.completed') {
          const id = typeof item.id === 'string' ? item.id : undefined
          steps.push({
            kind: 'tool_use',
            tool: item.type,
            input: webSearchInput(item),
            toolUseId: id,
            createdAt: at,
          })
          steps.push({
            kind: 'tool_result',
            text: '',
            toolUseId: id,
            isError: false,
            createdAt: at,
          })
        }
      } else if (item.type === 'collab_tool_call') {
        // A multi-agent call, its `tool` leading the input. As of Codex 0.154
        // only `wait` reaches the public stream, with its prompt, receivers and
        // agent states empty; the prompt and each agent's closing message are
        // shown whenever Codex fills them in.
        const id = typeof item.id === 'string' ? item.id : undefined
        const tool = item.type
        if (ev.type === 'item.started') {
          const name = typeof item.tool === 'string' ? item.tool : ''
          const prompt = typeof item.prompt === 'string' ? item.prompt : ''
          const input = prompt
            ? `${name}: ${summarizeToolInput({ description: prompt })}`
            : name
          const inputFull = prompt
            ? `${name}: ${fullToolInput({ description: prompt })}`
            : name
          steps.push({
            kind: 'tool_use',
            tool,
            input,
            ...(inputFull !== input ? { inputFull } : {}),
            toolUseId: id,
            createdAt: at,
          })
        } else {
          steps.push({
            kind: 'tool_result',
            text: summarizeToolResult(agentStates(item)),
            toolUseId: id,
            isError: item.status === 'failed',
            createdAt: at,
          })
        }
      } else if (item.type === 'error' && typeof item.message === 'string') {
        // A non-fatal notice — a config warning, a deprecation, a model reroute
        // — that Codex reports as a completed `error` item and carries on past.
        // Fatal errors are the top-level `error` event below instead.
        const input = summarizeToolInput({ description: item.message })
        const inputFull = fullToolInput({ description: item.message })
        steps.push({
          kind: 'tool_use',
          tool: item.type,
          input,
          ...(inputFull !== input ? { inputFull } : {}),
          toolUseId: item.id,
          createdAt: at,
        })
        steps.push({
          kind: 'tool_result',
          text: '',
          toolUseId: item.id,
          isError: true,
          createdAt: at,
        })
        notice = true
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

  return { steps, finalText, threadUsage, terminalError, ...(notice ? { notice } : {}) }
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

// A file_change item's `changes`: each a path and an add/delete/update kind.
function fileChanges(item: any): { path: string; kind: string }[] {
  if (!Array.isArray(item.changes)) return []
  return item.changes.filter(
    (c: any) => typeof c?.path === 'string' && typeof c.kind === 'string',
  )
}

// What a web search did, from its `action`: the query for a search, and the
// action with its page for the others.
function webSearchInput(item: any): string {
  const a = item.action
  if (a?.type === 'search') {
    if (typeof a.query === 'string' && a.query) return a.query
    if (Array.isArray(a.queries)) return a.queries.join(', ')
  }
  if (typeof a?.url === 'string') {
    const pattern = typeof a.pattern === 'string' ? ` ${a.pattern}` : ''
    return `${a.type} ${a.url}${pattern}`
  }
  return typeof item.query === 'string' ? item.query : ''
}

// A multi-agent call's report on the agents it touched: each one's status and,
// when it has one, its message.
function agentStates(item: any): string {
  const states =
    item.agents_states && typeof item.agents_states === 'object'
      ? Object.values(item.agents_states)
      : []
  return states
    .map((s: any) =>
      [s?.status, s?.message].filter((v) => typeof v === 'string' && v).join(': '),
    )
    .filter(Boolean)
    .join('\n')
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
