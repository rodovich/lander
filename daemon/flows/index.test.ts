// The capability view the daemon reads before a host exists, and which side
// answers it. This is the cutover's hinge: flipping a provider changes where
// these answers come from, and nothing else in the daemon should notice.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createClaudeAdapter } from '../claude'
import { createCodexAdapter } from '../codex'
import { FLOW_MODULES, providerCaps } from './index'
import type { AgentLaunchDirInput } from '../agent'
import { meta as claudeMeta } from './claude'
import { meta as codexMeta } from './codex'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function adapters() {
  return {
    claude: createClaudeAdapter({
      landerBin: '/repo/bin/lander',
      taskPromptTemplate: 'Prompt: {{forwardable}}.',
    }),
    codex: createCodexAdapter({ taskPromptTemplate: 'Prompt: {{forwardable}}.' }),
  }
}

describe('provider caps', () => {
  it('remaps the flow vision capability onto the daemon’s visionNative flag', () => {
    // 'read' means the agent must Read the path (claude); 'flag' means the
    // provider takes the image on the CLI and feeds its own vision (codex). The
    // manifest block is worded from this, so getting the remap backwards would
    // silently tell an agent its images are attached when they are not.
    const caps = providerCaps(adapters())
    expect(claudeMeta.capabilities.vision).toBe('read')
    expect(caps.claude.visionNative).toBe(false)
    expect(codexMeta.capabilities.vision).toBe('flag')
    expect(caps.codex.visionNative).toBe(true)
  })

  it('answers every flow from its flow module, agreeing with the adapter oracle', () => {
    const a = adapters()
    const caps = providerCaps(a)
    for (const agent of ['claude', 'codex'] as const) {
      // Every flow is answered from its module now — LIVE_FLOWS is gone as a
      // gate. The values must still agree with the compiled adapter, because
      // during a drain window an old daemon answers these from the adapter
      // while a new one answers from the flow.
      expect(caps[agent].visionNative).toBe(a[agent].attachesImagesToVision)
      expect(caps[agent].usageSnapshot).toBe(a[agent].supportsUsageSnapshot)
      expect(caps[agent].projectGrants).toBe(a[agent].supportsProjectGrants)
    }
  })

  it('enumerates from FLOW_MODULES, so an adapter-less flow gets caps', () => {
    // The regression this commit exists to prevent. providerCaps used to
    // enumerate Object.keys(adapters) and then branch through fromAdapter for
    // anything not in LIVE_FLOWS — two independent reasons a flow with no
    // compiled adapter was structurally unreachable. C5's live verify uses only
    // claude and codex and so cannot catch either.
    const synthetic = {
      meta: {
        api: 1,
        name: 'synthetic',
        description: 'a flow with no compiled adapter',
        driver: true,
        capabilities: {
          worktrees: false,
          vision: 'read' as const,
          grants: { task: false, project: false },
          usageSnapshot: false,
          rateLimitRetry: false,
          reportsCost: false,
        },
      },
      resolveLaunchDir: ({ recordedCwd, root }: AgentLaunchDirInput) => ({
        cwd: recordedCwd ?? root,
        reentryArgs: [],
      }),
    }
    FLOW_MODULES.synthetic = synthetic
    try {
      const caps = providerCaps(adapters())
      expect(caps.synthetic).toBeDefined()
      expect(caps.synthetic.projectGrants).toBe(false)
      expect(caps.synthetic.visionNative).toBe(false)
      expect(
        caps.synthetic.resolveLaunchDir({
          root: '/repo',
          recordedCwd: '/repo/sub',
          isDir: () => true,
        }),
      ).toEqual({ cwd: '/repo/sub', reentryArgs: [] })
    } finally {
      delete FLOW_MODULES.synthetic
    }
  })

  it('resolves the same launch dirs from either side', () => {
    const a = adapters()
    const caps = providerCaps(a)
    const isDir = (p: string) => p === '/repo/sub'

    // Claude: root is the permission boundary; a worktree is re-entered by argv.
    expect(
      caps.claude.resolveLaunchDir({
        root: '/repo',
        worktree: 'feature',
        recordedCwd: '/repo/sub',
        isDir,
      }),
    ).toEqual(
      a.claude.resolveLaunchDir({
        root: '/repo',
        worktree: 'feature',
        recordedCwd: '/repo/sub',
        isDir,
      }),
    )

    // Codex: resumes from the recorded cwd when it still exists.
    expect(
      caps.codex.resolveLaunchDir({ root: '/repo', recordedCwd: '/repo/sub', isDir }),
    ).toEqual(
      a.codex.resolveLaunchDir({ root: '/repo', recordedCwd: '/repo/sub', isDir }),
    )
  })

  it('declares rateLimitRetry iff the flow actually emits a reset timestamp', () => {
    // The capability is advisory — nothing gates on it, because the
    // scheduled-retry option gates on the *datum* (`resetsAt` present in the
    // ask), which only a flow with the capability can produce. This is the one
    // cheap check that keeps the two from disagreeing.
    //
    // Asserted against the module's source text rather than a runtime probe:
    // "can this flow's meter path emit rateLimitResetsAt" is a property over the
    // whole input space, so any probe would be a hand-picked sample mirroring
    // the implementation instead of constraining it. Source text is crude but
    // genuinely falsifiable in both directions — adding the emission to codex,
    // or removing it from claude, fails this without a meta change.
    for (const [file, meta] of [
      ['claude.ts', claudeMeta],
      ['codex.ts', codexMeta],
    ] as const) {
      const src = readFileSync(path.join(HERE, file), 'utf8')
      const emits = /emit\.meter\(\{[^}]*rateLimitResetsAt/s.test(src)
      expect(emits).toBe(meta.capabilities.rateLimitRetry)
    }
  })

  it('carries the unsupported-grant reason for a provider that cannot persist one', () => {
    const caps = providerCaps(adapters())
    expect(caps.codex.projectGrants).toBe(false)
    expect(caps.codex.projectGrantsUnsupportedReason).toBe(
      'Project permission grants are not supported for Codex tasks yet.',
    )
  })
})
