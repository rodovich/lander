import { beforeEach, describe, expect, it } from 'vitest'
import type { FlowAnnouncement, FlowMeta } from './protocol'
import {
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

  it('starts empty and gives unannounced flows the conservative capability floor', () => {
    expect(flowRegistry('proj')).toEqual([])
    expect(flowMeta('claude')).toBeUndefined()
    expect(flowCaps('claude')).toEqual({
      grants: { task: false, project: false },
    })
  })

  it('returns announced flows and derives their capabilities', () => {
    setAnnouncedFlows([
      bundled(meta('claude', { grants: { task: true, project: false } })),
      bundled(meta('example-flow')),
    ])
    expect(flowRegistry('proj').map((f) => f.name)).toEqual([
      'claude',
      'example-flow',
    ])
    expect(flowCaps('claude')).toEqual({ grants: { task: true, project: false } })
    expect(flowMeta('claude')?.description).toBe('the claude flow')
  })

  it('offers only announced flows', () => {
    setAnnouncedFlows([bundled(meta('example-flow'))])
    for (const f of flowRegistry('proj'))
      expect(isAnnouncedFlow(f.name)).toBe(true)
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
    ])
  })

  it('degrades an unknown flow to the conservative capability floor', () => {
    expect(flowCaps('never-heard-of-it')).toEqual({
      grants: { task: false, project: false },
    })
    expect(flowMeta('never-heard-of-it')).toBeUndefined()
  })

  it('gates dispatch on the announcement', () => {
    expect(isAnnouncedFlow('claude')).toBe(false)
    setAnnouncedFlows([bundled(meta('claude'))])
    expect(isAnnouncedFlow('claude')).toBe(true)
  })

  it('clears the announcement when the primary drops', () => {
    setAnnouncedFlows([bundled(meta('example-flow'))])
    expect(isAnnouncedFlow('example-flow')).toBe(true)
    clearAnnouncedFlows()
    expect(isAnnouncedFlow('example-flow')).toBe(false)
    expect(flowRegistry('proj')).toEqual([])
  })

  it('treats an absent flows field as an announcement of nothing', () => {
    setAnnouncedFlows([bundled(meta('example-flow'))])
    setAnnouncedFlows([])
    expect(isAnnouncedFlow('example-flow')).toBe(false)
  })
})
