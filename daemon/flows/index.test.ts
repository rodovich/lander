// The capability view the daemon reads before a host exists, and which side
// answers it. This is the cutover's hinge: flipping a provider changes where
// these answers come from, and nothing else in the daemon should notice.

import { describe, expect, it } from 'vitest'
import { createClaudeAdapter } from '../claude'
import { createCodexAdapter } from '../codex'
import { LIVE_FLOWS, providerCaps } from './index'
import { meta as claudeMeta } from './claude'
import { meta as codexMeta } from './codex'

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

  it('answers a cut-over provider from its flow and the rest from adapters', () => {
    const a = adapters()
    const caps = providerCaps(a)
    for (const agent of ['claude', 'codex'] as const) {
      const live = LIVE_FLOWS.has(agent)
      // Whichever side answers, the values must agree with the compiled adapter
      // — the port moved this code verbatim, and during a drain window an old
      // daemon answers from the adapter while a new one answers from the flow.
      // Any deliberate divergence has to wait until every provider has flipped.
      expect(caps[agent].visionNative).toBe(a[agent].attachesImagesToVision)
      expect(caps[agent].usageSnapshot).toBe(a[agent].supportsUsageSnapshot)
      expect(caps[agent].projectGrants).toBe(a[agent].supportsProjectGrants)
      expect(typeof live).toBe('boolean')
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

  it('carries the unsupported-grant reason for a provider that cannot persist one', () => {
    const caps = providerCaps(adapters())
    expect(caps.codex.projectGrants).toBe(false)
    expect(caps.codex.projectGrantsUnsupportedReason).toBe(
      'Project permission grants are not supported for Codex tasks yet.',
    )
  })
})
