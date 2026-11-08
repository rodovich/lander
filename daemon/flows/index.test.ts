import { describe, expect, it, vi } from 'vitest'
import { FLOW_MODULES, announcedFlows, buildFlows, providerCaps } from './index'
import { runHost } from '../flow-host'
import type { HostEvent } from '../host-protocol'
import { ROOT } from '../paths'
import { goldenInput, settle } from './testCtx'
import type { AgentLaunchDirInput } from '../agent'

describe('provider caps', () => {
  it('makes one registration announced, capable, and executable by the host', async () => {
    const synthetic: (typeof FLOW_MODULES)[string] = {
      meta: {
        api: 1,
        name: 'synthetic',
        description: 'an orchestration flow',
        driver: true,
        capabilities: {
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
          start: { flow: 'synthetic' },
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
      expect(
        caps.synthetic.resolveLaunchDir({
          root: '/repo',
          recordedCwd: '/repo/sub',
          isDir: () => true,
        }),
      ).toEqual({ cwd: '/repo/sub' })
    } finally {
      delete FLOW_MODULES.synthetic
    }
  })

  it('resolves launch directories from the flow modules', () => {
    const caps = providerCaps()
    const isDir = (p: string) => p === '/repo/sub'

    // Claude: root is the permission boundary, whatever the last turn's cwd.
    expect(
      caps.claude.resolveLaunchDir({ root: '/repo', recordedCwd: '/repo/sub', isDir }),
    ).toEqual({ cwd: '/repo' })

    // Codex: resumes from the recorded cwd when it still exists.
    expect(
      caps.codex.resolveLaunchDir({ root: '/repo', recordedCwd: '/repo/sub', isDir }),
    ).toEqual({ cwd: '/repo/sub' })
  })

  it('declares rateLimitRetry for every flow with a usage snapshot', () => {
    // The capability is advisory — nothing gates on it, because the
    // scheduled-retry option gates on the *datum* (a reset time present in the
    // ask). The daemon can fetch one from a flow's usage snapshot when a turn
    // fails, so every flow with a snapshot can get one.
    for (const mod of Object.values(FLOW_MODULES))
      if (mod.meta.capabilities.usageSnapshot && mod.onStatus)
        expect(mod.meta.capabilities.rateLimitRetry).toBe(true)
  })

  it('carries the unsupported-grant reason for a provider that cannot persist one', () => {
    const caps = providerCaps()
    expect(caps.codex.projectGrants).toBe(false)
    expect(caps.codex.projectGrantsUnsupportedReason).toBe(
      'Project permission grants are not supported for Codex tasks yet.',
    )
  })
})
