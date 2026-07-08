import type { AgentAdapter, AgentLineUpdate, AgentTaskView } from './agent'
import type { Usage } from '../server/stream'
import { summarizeToolResult, toolRule } from '../server/stream'
import { promptWithTaskManagement } from './task-management'

export type CodexAdapterOptions = {
  taskPromptTemplate: string
  profile?: string
  configOverrides?: string[]
}

const CODEX_SHELL_ENV_INCLUDE_ONLY = [
  'PATH',
  'LANDER_*',
] as const

export function createCodexAdapter({
  taskPromptTemplate,
  profile,
  configOverrides = [],
}: CodexAdapterOptions): AgentAdapter {
  return {
    kind: 'codex',
    command: 'codex',
    buildLaunch({ task, prompt, cwd, landerEnv }) {
      return {
        args: buildCodexArgs(task, prompt, cwd, {
          taskPromptTemplate,
          profile,
          configOverrides,
        }),
        env: landerEnv,
      }
    },
    buildSession() {
      return {
        args: [],
        announceSession: false,
      }
    },
    reduceLine: reduceCodexStreamLine,
    extractSession: extractCodexSession,
    supportsProjectGrants: false,
    supportsWorktreeFlag: false,
    supportsUsageSnapshot: false,
    supportsRateLimitRetryScheduling: false,
  }
}

function buildCodexArgs(
  task: AgentTaskView,
  prompt: string,
  cwd: string,
  {
    taskPromptTemplate,
    profile,
    configOverrides,
  }: {
    taskPromptTemplate: string
    profile?: string
    configOverrides: string[]
  },
): string[] {
  const sandboxMode = task.allowEdits ? 'workspace-write' : 'read-only'
  const configOverridesWithLanderDefaults = [
    ...configOverrides,
    // `lander` self-management commands call back to the local Lander API.
    // Codex keeps workspace-write network access off by default, so opt in per
    // Lander-run without requiring a user profile.
    'sandbox_workspace_write.network_access=true',
    ...codexShellEnvConfigOverrides(),
  ]
  const managedPrompt = promptWithTaskManagement(
    { ...task, agent: 'codex' },
    prompt,
    taskPromptTemplate,
  )
  if (task.sessionId)
    return [
      'exec',
      'resume',
      '--json',
      ...codexConfigArgs(profile, [
        ...configOverridesWithLanderDefaults,
        `sandbox_mode=${tomlString(sandboxMode)}`,
      ]),
      task.sessionId,
      managedPrompt,
    ]
  const configArgs = codexConfigArgs(profile, configOverridesWithLanderDefaults)
  return [
    'exec',
    '--json',
    ...configArgs,
    '--cd',
    cwd,
    '--sandbox',
    sandboxMode,
    managedPrompt,
  ]
}

export function codexOptionsFromEnv(env: {
  LANDER_CODEX_PROFILE?: string | undefined
  LANDER_CODEX_CONFIG?: string | undefined
}): Pick<CodexAdapterOptions, 'profile' | 'configOverrides'> {
  const profile = env.LANDER_CODEX_PROFILE?.trim() || undefined
  const configOverrides =
    env.LANDER_CODEX_CONFIG?.split('\n')
      .map((line) => line.trim())
      .filter(Boolean) ?? []
  return {
    ...(profile ? { profile } : {}),
    ...(configOverrides.length ? { configOverrides } : {}),
  }
}

function codexConfigArgs(
  profile: string | undefined,
  configOverrides: string[],
): string[] {
  return [
    ...(profile ? ['--profile', profile] : []),
    ...configOverrides.flatMap((entry) => ['--config', entry]),
  ]
}

function codexShellEnvConfigOverrides(): string[] {
  // Let Lander vars flow from the child process env so LANDER_TOKEN stays out of argv.
  return [
    'shell_environment_policy.inherit=all',
    'shell_environment_policy.ignore_default_excludes=true',
    `shell_environment_policy.include_only=${tomlArray(CODEX_SHELL_ENV_INCLUDE_ONLY)}`,
  ]
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(',')}]`
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
): AgentLineUpdate {
  const ev = parseJson(line)
  if (!ev) return { steps: [] }

  const steps: AgentLineUpdate['steps'] = []
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
        const command = typeof item.command === 'string' ? item.command : ''
        if (ev.type === 'item.started') {
          steps.push({
            kind: 'tool_use',
            tool: 'Bash',
            input: command,
            toolUseId: id,
            rule: toolRule('Bash', { command }),
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
        const path = firstChangePath(item)
        steps.push({
          kind: 'tool_use',
          tool: 'FileChange',
          input: summarizeFileChange(item),
          toolUseId: id,
          rule: path ? toolRule('FileChange', { path }) : 'FileChange',
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
