import { readFileSync } from 'node:fs'
import path from 'node:path'
import { readProjectDoc } from 'lander/flow'
import type { FlowAnnouncement } from '../../server/protocol'
import type { AgentLaunchDir, AgentLaunchDirInput } from '../agent'
import * as claudeFlowModule from './claude'
import * as codexFlowModule from './codex'
import * as openPrFlowModule from './open-pr'
import type { Ctx, FlowMeta, TurnResult } from './ctx'

export type BundledFlow = {
  meta: FlowMeta
  onTurn(ctx: Ctx): Promise<TurnResult>
}

type FlowBuildContext = {
  landerBin: string
  taskPromptTemplate: string
  env: NodeJS.ProcessEnv
}

type BundledFlowModule = {
  meta: FlowMeta
  create(context: FlowBuildContext): BundledFlow
  resolveLaunchDir(input: AgentLaunchDirInput): AgentLaunchDir
  onGrant?(
    ctx: unknown,
    grant: { projectPath: string; rule: string },
  ): Promise<void>
  onStatus?(): Promise<{ items: unknown[]; refreshAt?: string } | null>
}

// One registration supplies execution, announcement, capabilities, and hooks.
export const FLOW_MODULES: Record<string, BundledFlowModule> = {
  claude: {
    ...claudeFlowModule,
    create: ({ landerBin, taskPromptTemplate }) =>
      claudeFlowModule.makeFlow({
        landerBin,
        taskPromptTemplate,
        readProjectDoc,
      }),
  },
  codex: {
    ...codexFlowModule,
    create: ({ taskPromptTemplate, env }) =>
      codexFlowModule.makeFlow({
        taskPromptTemplate,
        readProjectDoc,
        ...codexFlowModule.codexOptionsFromEnv(env),
      }),
  },
  'open-pr': {
    ...openPrFlowModule,
    create: () => openPrFlowModule.makeFlow(),
  },
}

export function buildFlows({
  root,
  env,
}: {
  root: string
  env: NodeJS.ProcessEnv
}): Record<string, BundledFlow> {
  // root is Lander's install root. Each driver reads the target project's
  // LANDER.md per turn through readProjectDoc, using that turn's directory.
  const context: FlowBuildContext = {
    landerBin: path.join(root, 'bin', 'lander'),
    taskPromptTemplate: readFileSync(
      path.join(root, 'server', 'task-prompt.md'),
      'utf8',
    ).trim(),
    env,
  }
  return Object.fromEntries(
    Object.entries(FLOW_MODULES).map(([name, mod]) => [name, mod.create(context)]),
  )
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

export { meta as claudeMeta } from './claude'
export { meta as codexMeta } from './codex'
