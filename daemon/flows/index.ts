// Shared construction of the bundled driver flows, and the capability view the
// daemon reads before any host exists.
//
// Mirrors daemon/adapters.ts deliberately: one constructor serves both the
// daemon (which needs a flow's meta and its out-of-turn hooks) and the flow host
// (which needs its onTurn), so the two cannot drift on landerBin, the task-prompt
// template, or codexOptionsFromEnv.
//
// The step-3 cutover switch (LIVE_FLOWS) is gone. It was a per-provider revert
// lever, meaningful only for a provider that HAS a compiled oracle to revert to;
// both have flipped, and keeping it as a gate would have excluded every future
// flow by construction, since an adapter-less flow can never be in it.
// Membership in FLOW_MODULES is now what makes a flow runnable.
// RunHostDeps.liveFlows survives as a test-only seam for reaching the still-live
// adapter bridge.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { readProjectDoc } from 'lander/flow'
import type { AgentKind, FlowAnnouncement } from '../../server/protocol'
import type { AgentAdapter, AgentLaunchDir, AgentLaunchDirInput } from '../agent'
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
    // The first bundled flow with no compiled adapter — which is what C5's
    // enumeration fix exists to make reachable at all.
    'open-pr': makeOpenPrFlow(),
  }
}

// Every flow this daemon can drive, keyed by flow name. The key is `string`, not
// AgentKind: a flow need not have a compiled adapter, and from C5 on nothing
// requires it to. This map is the single registration point — it decides what
// runs (flow-host selection), what the daemon knows before a host exists
// (providerCaps), and what the server is told (announcedFlows).
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

// What this daemon can drive, as the server's flow registry consumes it. Built
// from FLOW_MODULES so registering a flow module is the single act that makes it
// both runnable and announced — the two cannot drift.
//
// Everything is `bundled` at step 4. Step 5 adds the user- and project-scoped
// entries the envelope already has room for.
export function announcedFlows(): FlowAnnouncement[] {
  return Object.values(FLOW_MODULES).map((mod) => ({
    scope: 'bundled' as const,
    meta: mod.meta,
  }))
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

// Per flow, answered by the flow module. Enumerated from FLOW_MODULES — NOT
// from the adapter set, which is the difference between a registry that can
// carry a new flow and one that structurally cannot.
//
// Both halves of that mattered. Enumerating `Object.keys(adapters)` gave an
// adapter-less flow no entry at all; and the `LIVE_FLOWS.has(agent) ? fromFlow
// : fromAdapter` ternary that used to sit below would then have sent such a
// flow down fromAdapter, dereferencing `adapters[name]` — undefined — for a
// TypeError. Changing only the enumeration source reproduces the second bug
// exactly, so the ternary goes with it. Both providers have flipped, so
// fromAdapter has no live caller left; the adapters survive as the parity
// oracle until step 5.
//
// `adapters` stays in the signature for the parity harness's lookup only.
export function providerCaps(
  _adapters: Record<AgentKind, AgentAdapter>,
): Record<string, ProviderCaps> {
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
