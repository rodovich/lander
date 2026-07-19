// The flow registry: what the server can dispatch to, and the capabilities it
// derives from a flow's announced meta.
//
// The load-bearing case is the *disagreement* one — an announced set whose metas
// differ from the frozen bootstrap literal. That case is only expressible
// because BOOTSTRAP_FLOWS is a literal rather than an import of the daemon's
// metas; had it been an import, the two sources would be identical by
// construction and every fallback test would be vacuous.

import { beforeEach, describe, expect, it } from 'vitest'
import type { FlowAnnouncement, FlowMeta } from './protocol'
import {
  BOOTSTRAP_FLOWS,
  clearAnnouncedFlows,
  flowCaps,
  flowMeta,
  flowRegistry,
  isAnnouncedFlow,
  setAnnouncedFlows,
} from './flows'

function meta(name: string, over: Partial<FlowMeta['capabilities']> = {}): FlowMeta {
  return {
    api: 1,
    name,
    description: `the ${name} flow`,
    driver: true,
    capabilities: {
      worktrees: false,
      vision: 'read',
      grants: { task: false, project: false },
      usageSnapshot: false,
      rateLimitRetry: false,
      reportsCost: false,
      ...over,
    },
  }
}

function bundled(m: FlowMeta): FlowAnnouncement {
  return { scope: 'bundled', meta: m }
}

describe('flow registry', () => {
  beforeEach(() => clearAnnouncedFlows())

  it('serves the legacy bootstrap flows when nothing has been announced', () => {
    // The window between server boot (or a primary disconnect) and the first
    // register. The picker must still render and existing claude/codex tasks
    // must still derive capabilities.
    expect(flowRegistry('proj').map((f) => f.name)).toEqual(['claude', 'codex'])
    expect(flowCaps('claude')).toEqual({
      grants: { task: true, project: true },
      reportsCost: true,
    })
    expect(flowCaps('codex')).toEqual({
      grants: { task: false, project: false },
      reportsCost: false,
    })
  })

  it('prefers an announced meta over the bootstrap entry of the same name', () => {
    // The falsifiable case: a daemon whose build disagrees with the server's
    // frozen literal. The announcement is the live truth — the literal is only
    // a floor for the window before one arrives.
    setAnnouncedFlows([
      bundled(meta('claude', { grants: { task: true, project: false }, reportsCost: false })),
    ])
    expect(flowCaps('claude')).toEqual({
      grants: { task: true, project: false },
      reportsCost: false,
    })
    expect(flowMeta('claude')?.description).toBe('the claude flow')
    // Codex was not announced, so it still falls back.
    expect(flowCaps('codex').grants).toEqual({ task: false, project: false })
    expect(flowMeta('codex')?.description).toBe('Drive a task as a Codex conversation')
  })

  it('unions announced flows with the legacy entries, announced first', () => {
    setAnnouncedFlows([bundled(meta('open-pr')), bundled(meta('claude'))])
    expect(flowRegistry('proj').map((f) => f.name)).toEqual([
      'open-pr',
      'claude',
      'codex',
    ])
  })

  it('offers only announced or legacy flows — never a name that would wedge', () => {
    // The picker invariant. Anything flowRegistry returns must either have been
    // announced (so dispatch is gated open) or be a legacy flow (which carries
    // StartRunMessage.agent and so bypasses the gate).
    setAnnouncedFlows([bundled(meta('open-pr'))])
    const legacy = new Set(BOOTSTRAP_FLOWS.map((m) => m.name))
    for (const f of flowRegistry('proj'))
      expect(isAnnouncedFlow(f.name) || legacy.has(f.name)).toBe(true)
  })

  it('filters project-scoped announcements to their own project', () => {
    setAnnouncedFlows([
      { scope: 'project', project: 'other', meta: meta('theirs') },
      { scope: 'project', project: 'mine', meta: meta('ours') },
      bundled(meta('everywhere')),
    ])
    expect(flowRegistry('mine').map((f) => f.name)).toEqual([
      'ours',
      'everywhere',
      'claude',
      'codex',
    ])
  })

  it('degrades an unknown flow to the conservative capability floor', () => {
    // Not "fully capable" — a flow the server has never heard of must not be
    // advertised as honoring a grant scope it may ignore.
    expect(flowCaps('never-heard-of-it')).toEqual({
      grants: { task: false, project: false },
      reportsCost: false,
    })
    expect(flowMeta('never-heard-of-it')).toBeUndefined()
  })

  it('gates dispatch on the announcement, not on the bootstrap union', () => {
    // Bootstrap entries are deliberately NOT announced: they are the legacy
    // flows, which dispatch carries `agent` for.
    expect(isAnnouncedFlow('claude')).toBe(false)
    setAnnouncedFlows([bundled(meta('claude'))])
    expect(isAnnouncedFlow('claude')).toBe(true)
  })

  it('clears the announcement when the primary drops', () => {
    // A rolled-back daemon must not inherit its predecessor's announcement —
    // otherwise the dispatch gate lets through a flow the live daemon lacks.
    setAnnouncedFlows([bundled(meta('open-pr'))])
    expect(isAnnouncedFlow('open-pr')).toBe(true)
    clearAnnouncedFlows()
    expect(isAnnouncedFlow('open-pr')).toBe(false)
    expect(flowRegistry('proj').map((f) => f.name)).toEqual(['claude', 'codex'])
  })

  it('treats an absent flows field as an announcement of nothing', () => {
    setAnnouncedFlows([bundled(meta('open-pr'))])
    setAnnouncedFlows([]) // what `msg.flows ?? []` yields from an old daemon
    expect(isAnnouncedFlow('open-pr')).toBe(false)
  })
})
