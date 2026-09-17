import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { FLOW_MODULES, announcedFlows, buildFlows, providerCaps } from './index'
import { runHost } from '../flow-host'
import type { HostEvent } from '../host-protocol'
import { ROOT } from '../paths'
import { goldenInput, settle } from './testCtx'
import type { AgentLaunchDirInput } from '../agent'
import { meta as claudeMeta } from './claude'
import { meta as codexMeta } from './codex'

const HERE = path.dirname(fileURLToPath(import.meta.url))

describe('provider caps', () => {
  it('remaps the flow vision capability onto the daemon’s visionNative flag', () => {
    // 'read' means the agent must Read the path (claude); 'flag' means the
    // provider takes the image on the CLI and feeds its own vision (codex). The
    // manifest block is worded from this, so getting the remap backwards would
    // silently tell an agent its images are attached when they are not.
    const caps = providerCaps()
    expect(claudeMeta.capabilities.vision).toBe('read')
    expect(caps.claude.visionNative).toBe(false)
    expect(codexMeta.capabilities.vision).toBe('flag')
    expect(caps.codex.visionNative).toBe(true)
  })

  it('makes one registration announced, capable, and executable by the host', async () => {
    const synthetic: (typeof FLOW_MODULES)[string] = {
      meta: {
        api: 1,
        name: 'synthetic',
        description: 'an orchestration flow',
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
      create: () => ({
        meta: synthetic.meta,
        onTurn: async (ctx) => {
          ctx.emit.message('synthetic ran')
          return { exitCode: 0 }
        },
      }),
      resolveLaunchDir: ({ recordedCwd, root }: AgentLaunchDirInput) => ({
        cwd: recordedCwd ?? root,
        reentryArgs: [],
      }),
    }
    FLOW_MODULES.synthetic = synthetic
    try {
      expect(announcedFlows()).toContainEqual({
        scope: 'bundled',
        meta: synthetic.meta,
      })
      const built = buildFlows({ root: ROOT, env: {} })
      expect(Object.keys(built)).toEqual(Object.keys(FLOW_MODULES))
      expect(built.synthetic.meta).toEqual(synthetic.meta)
      const events: HostEvent[] = []
      const spawn = vi.fn()
      runHost(
        goldenInput({
          name: 'registry',
          chunks: [],
          start: { flow: 'synthetic', agent: undefined },
        }),
        { emit: (event) => events.push(event), spawn },
      )
      await settle()
      expect(spawn).not.toHaveBeenCalled()
      expect(events).toContainEqual(expect.objectContaining({
        kind: 'update',
        steps: expect.arrayContaining([
          expect.objectContaining({ text: 'synthetic ran' }),
        ]),
      }))
      expect(events.at(-1)).toEqual({ kind: 'done', exitCode: 0, stderr: '' })
      const caps = providerCaps()
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

  it('resolves launch directories from the flow modules', () => {
    const caps = providerCaps()
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
      { cwd: '/repo', reentryArgs: ['--worktree', 'feature'], effectiveCwd: '/repo/.claude/worktrees/feature' },
    )

    // Codex: resumes from the recorded cwd when it still exists.
    expect(
      caps.codex.resolveLaunchDir({ root: '/repo', recordedCwd: '/repo/sub', isDir }),
    ).toEqual(
      { cwd: '/repo/sub', reentryArgs: [] },
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
    const caps = providerCaps()
    expect(caps.codex.projectGrants).toBe(false)
    expect(caps.codex.projectGrantsUnsupportedReason).toBe(
      'Project permission grants are not supported for Codex tasks yet.',
    )
  })
})
