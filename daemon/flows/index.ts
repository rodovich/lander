import { readFileSync } from 'node:fs'
import path from 'node:path'
import { readProjectDoc } from 'lander/flow'
import type { FlowAnnouncement } from '../../server/protocol'
import type { AgentLaunchDir, AgentLaunchDirInput } from '../agent'
import { makeFlow as makeClaudeFlow, meta as claudeMeta } from './claude'
import {
  makeFlow as makeCodexFlow,
  meta as codexMeta,
  codexOptionsFromEnv,
} from './codex'
import { makeFlow as makeOpenPrFlow } from './open-pr'
import * as claudeFlowModule from './claude'
import * as codexFlowModule from './codex'
import * as openPrFlowModule from './open-pr'
import type { Ctx, FlowMeta, TurnResult } from './ctx'

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
}): Record<string, BundledFlow> {
  const taskPromptTemplate = readFileSync(
    path.join(root, 'server', 'task-prompt.md'),
    'utf8',
  ).trim()
  // NOTE: `root` here is lander's own install root — it is where task-prompt.md
  // and bin/lander live, NOT the project the task runs in. The project doc must
  // therefore be read per turn from the task's own directory, so what is wired in
  // is the reader itself, never a path or a resolved doc.
  return {
    claude: makeClaudeFlow({
      landerBin: path.join(root, 'bin', 'lander'),
      taskPromptTemplate,
      readProjectDoc,
    }),
    codex: makeCodexFlow({
      taskPromptTemplate,
      readProjectDoc,
      ...codexOptionsFromEnv(env),
    }),
    'open-pr': makeOpenPrFlow(),
  }
}

// Metadata and out-of-turn hooks for bundled flows. Keep these names aligned
// with the executable factories in buildFlows; orchestration flows need not
// drive an agent CLI.
export const FLOW_MODULES: Record<
  string,
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
  'open-pr': openPrFlowModule,
}

// Announce bundled flow metadata to the server's registry.
export function announcedFlows(): FlowAnnouncement[] {
  return Object.values(FLOW_MODULES).map((mod) => ({
    scope: 'bundled' as const,
    meta: mod.meta,
  }))
}

// What the daemon needs to know about a flow BEFORE a host exists: where to
// launch, whether images go to vision natively, and whether it owns the global
// usage panel.
export type ProviderCaps = {
  resolveLaunchDir(input: AgentLaunchDirInput): AgentLaunchDir
  // The manifest block words image attachments differently depending on whether
  // the provider delivers them to its own vision or the agent must Read the path.
  visionNative: boolean
  usageSnapshot: boolean
  projectGrants: boolean
  projectGrantsUnsupportedReason?: string
}

// Capabilities used by the daemon before a per-turn host exists.
export function providerCaps(): Record<string, ProviderCaps> {
  const fromFlow = (name: string): ProviderCaps => {
    const mod = FLOW_MODULES[name]
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
  const caps: Record<string, ProviderCaps> = {}
  for (const name of Object.keys(FLOW_MODULES)) caps[name] = fromFlow(name)
  return caps
}

export { claudeMeta, codexMeta }
