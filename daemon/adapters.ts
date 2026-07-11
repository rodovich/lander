// Shared construction of the compiled-in claude/codex adapters. One constructor
// serves both the daemon (which imports the adapters for their *capabilities* and
// project-grant persistence) and the flow host (which imports them to *execute*),
// so the two can't drift on `landerBin`, the task-prompt template, or
// `codexOptionsFromEnv`. Step 2 keeps both adapters compiled in on both sides; the
// clean split (daemon sees only announced meta) is a later step.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentAdapter } from './agent'
import type { AgentKind } from '../server/protocol'
import { createClaudeAdapter } from './claude'
import { codexOptionsFromEnv, createCodexAdapter } from './codex'

// The repo root, derived the same way wherever this module runs (daemon or host):
// two levels up from daemon/adapters.ts. Both the landerBin path and the
// task-prompt template hang off it.
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

export function buildAdapters({
  root,
  env,
}: {
  root: string
  env: NodeJS.ProcessEnv
}): Record<AgentKind, AgentAdapter> {
  const taskPromptTemplate = readFileSync(
    path.join(root, 'server', 'task-prompt.md'),
    'utf8',
  ).trim()
  return {
    claude: createClaudeAdapter({
      landerBin: path.join(root, 'bin', 'lander'),
      taskPromptTemplate,
    }),
    codex: createCodexAdapter({
      taskPromptTemplate,
      ...codexOptionsFromEnv(env),
    }),
  }
}
