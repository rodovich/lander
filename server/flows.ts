import type { FlowAnnouncement, FlowMeta } from './protocol'

export type FlowCaps = Pick<FlowMeta['capabilities'], 'grants'>

// A flow the server has never heard of degrades to the conservative floor —
// no grant controls — rather than falsely advertising a capability the flow
// may not honor.
const UNKNOWN_FLOW_CAPS: FlowCaps = {
  grants: { task: false, project: false },
}

// What the current primary daemon announced. Empty until it registers.
let announced: FlowAnnouncement[] = []

export function setAnnouncedFlows(list: FlowAnnouncement[]): void {
  announced = list
}

export function clearAnnouncedFlows(): void {
  announced = []
}

export function announcedFlows(): FlowAnnouncement[] {
  return announced
}

export function flowMeta(name: string): FlowMeta | undefined {
  return announced.find((f) => f.meta.name === name)?.meta
}

export function isAnnouncedFlow(name: string): boolean {
  return flowMeta(name) !== undefined
}

export function flowRegistry(projectSlug: string): FlowMeta[] {
  const out: FlowMeta[] = []
  const seen = new Set<string>()
  for (const entry of announced) {
    if (entry.scope === 'project' && entry.project !== projectSlug) continue
    if (seen.has(entry.meta.name)) continue
    seen.add(entry.meta.name)
    out.push(entry.meta)
  }
  return out
}

export function flowCaps(name: string): FlowCaps {
  const meta = flowMeta(name)
  if (!meta) return UNKNOWN_FLOW_CAPS
  return { grants: meta.capabilities.grants }
}
