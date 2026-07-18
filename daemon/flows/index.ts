// Shared construction of the bundled driver flows, and the capability view the
// daemon reads before any host exists.
//
// Mirrors daemon/adapters.ts deliberately: one constructor serves both the
// daemon (which needs a flow's meta and its out-of-turn hooks) and the flow host
// (which needs its onTurn), so the two cannot drift on landerBin, the task-prompt
// template, or codexOptionsFromEnv.
//
// LIVE_FLOWS is the cutover switch. A provider listed here has its turns driven
// by its flow; one that isn't still runs as its compiled adapter. Each cutover
// flips one entry, and each flip is reversible on its own.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentKind } from '../../server/protocol'
import type { AgentAdapter, AgentLaunchDir, AgentLaunchDirInput } from '../agent'
import { makeFlow as makeClaudeFlow, meta as claudeMeta } from './claude'
import {
  makeFlow as makeCodexFlow,
  meta as codexMeta,
  codexOptionsFromEnv,
} from './codex'
import * as claudeFlowModule from './claude'
import * as codexFlowModule from './codex'
import type { Ctx, FlowMeta, TurnResult } from './ctx'

// Providers whose live turns run as flows rather than as compiled adapters.
// Both have flipped, so the compiled adapters no longer drive anything — they
// survive only as the parity oracle until step 5 deletes them, along with the
// adapter bridge that let their ids match the flows'.
export const LIVE_FLOWS: ReadonlySet<AgentKind> = new Set<AgentKind>([
  'claude',
  'codex',
])

export type BundledFlow = {
  meta: FlowMeta
  onTurn(ctx: Ctx): Promise<TurnResult>
}

export function buildFlows({
  root,
  env,
}: {
  root: string
  env: NodeJS.ProcessEnv
}): Record<AgentKind, BundledFlow> {
  const taskPromptTemplate = readFileSync(
    path.join(root, 'server', 'task-prompt.md'),
    'utf8',
  ).trim()
  return {
    claude: makeClaudeFlow({
      landerBin: path.join(root, 'bin', 'lander'),
      taskPromptTemplate,
    }),
    codex: makeCodexFlow({ taskPromptTemplate, ...codexOptionsFromEnv(env) }),
  }
}

export const FLOW_MODULES: Record<
  AgentKind,
  {
    meta: FlowMeta
    resolveLaunchDir(input: AgentLaunchDirInput): AgentLaunchDir
    onGrant?(
      ctx: unknown,
      grant: { projectPath: string; rule: string },
    ): Promise<void>
    onStatus?(): Promise<{ items: unknown[]; refreshAt?: string } | null>
  }
> = {
  claude: claudeFlowModule,
  codex: codexFlowModule,
}

// What the daemon needs to know about a provider BEFORE a host exists: where to
// launch, whether images go to vision natively, and whether it owns the global
// usage panel. The run manager is written against this one shape, so a cutover
// is a change of source here rather than a change of shape there.
export type ProviderCaps = {
  resolveLaunchDir(input: AgentLaunchDirInput): AgentLaunchDir
  // The manifest block words image attachments differently depending on whether
  // the provider delivers them to its own vision or the agent must Read the path.
  visionNative: boolean
  usageSnapshot: boolean
  projectGrants: boolean
  projectGrantsUnsupportedReason?: string
}

// Per provider, answered by its flow once it has cut over and by its compiled
// adapter until then. During a drain window an old daemon still answers these
// from the adapter while a new one answers from the flow — safe only because the
// moved code is verbatim, so any deliberate divergence has to wait until both
// providers have flipped.
export function providerCaps(
  adapters: Record<AgentKind, AgentAdapter>,
): Record<AgentKind, ProviderCaps> {
  const fromFlow = (agent: AgentKind): ProviderCaps => {
    const mod = FLOW_MODULES[agent]
    return {
      resolveLaunchDir: mod.resolveLaunchDir,
      visionNative: mod.meta.capabilities.vision === 'flag',
      usageSnapshot: mod.meta.capabilities.usageSnapshot,
      projectGrants: mod.meta.capabilities.grants.project,
      ...(mod.meta.projectGrantsUnsupportedReason
        ? {
            projectGrantsUnsupportedReason:
              mod.meta.projectGrantsUnsupportedReason,
          }
        : {}),
    }
  }
  const fromAdapter = (agent: AgentKind): ProviderCaps => {
    const a = adapters[agent]
    return {
      resolveLaunchDir: (input) => a.resolveLaunchDir(input),
      visionNative: a.attachesImagesToVision,
      usageSnapshot: a.supportsUsageSnapshot,
      projectGrants: a.supportsProjectGrants,
      ...(a.projectGrantsUnsupportedReason
        ? { projectGrantsUnsupportedReason: a.projectGrantsUnsupportedReason }
        : {}),
    }
  }
  const caps = {} as Record<AgentKind, ProviderCaps>
  for (const agent of Object.keys(adapters) as AgentKind[])
    caps[agent] = LIVE_FLOWS.has(agent) ? fromFlow(agent) : fromAdapter(agent)
  return caps
}

export { claudeMeta, codexMeta }
