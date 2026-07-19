// The flow registry: what the server knows about the driver flows it can
// dispatch to. The daemon announces its flows on every register (see
// RegisterMessage.flows); this module caches that announcement, serves it to the
// UI picker, and derives the per-task capability flags publicTask attaches.
//
// The server never interprets flow semantics — it stores meta as pass-through
// data and reads only the declared capabilities.
//
// Two properties make the cache safe to rely on for dispatch gating:
//
//   - It is set UNCONDITIONALLY on every primary register. An absent `flows`
//     field is an announcement of *nothing*, which is exactly right for a daemon
//     built before this field existed and for a rolled-back one.
//   - It is CLEARED when the primary drops, so a rolled-back daemon cannot
//     inherit its predecessor's announcement.
//
// It is process-local and non-durable. That is safe rather than merely
// tolerable: a missing announcement makes dispatch fail toward a wedge with a
// named reason, never toward running a task as the wrong flow. Durability
// becomes worth building when step 5 adds installed flows the bootstrap below
// cannot cover.

import type { FlowAnnouncement, FlowMeta } from './protocol'

// The flow a task falls back to when it names none — the legacy agent default.
export const LEGACY_FLOW = 'claude'

// The capability subset the server itself acts on, derived from a flow's
// announced meta. Everything else in FlowMeta is pass-through to the client.
export type FlowCaps = {
  grants: { task: boolean; project: boolean }
  reportsCost: boolean
}

// A flow the server has never heard of degrades to the conservative floor —
// "Save rule" instead of a grant menu, cost "n/a" — rather than falsely
// advertising a capability the flow may not honor.
const UNKNOWN_FLOW_CAPS: FlowCaps = {
  grants: { task: false, project: false },
  reportsCost: false,
}

// The legacy flows, frozen as an inline literal, for exactly one window: between
// server boot (or a primary disconnect) and the first register, when the UI must
// still render a picker and publicTask must still derive capabilities for the
// claude and codex tasks that already exist.
//
// Deliberately NOT imported from daemon/flows. No file under server/ imports
// from daemon/ today, and the API server runs as `tsx watch server/index.ts` — so
// an import would pull the whole daemon flow tree into the server's watch graph,
// and every edit to a daemon flow file (constant through the open-PR flow and
// steps 5-6) would hard-restart the API server at the same instant daemon-watch
// begins a drain handoff. An inline literal also *can* represent a daemon whose
// metas differ from the server's build, which is the rollback case the dispatch
// gate exists to survive and which an import is structurally incapable of
// modeling.
//
// These are frozen legacy facts, not a copy that can drift: step 5 deletes both
// entries along with the compiled-in adapters.
export const BOOTSTRAP_FLOWS: FlowMeta[] = [
  {
    api: 1,
    name: 'claude',
    description: 'Drive a task as a Claude Code conversation',
    driver: true,
    capabilities: {
      worktrees: true,
      vision: 'read',
      grants: { task: true, project: true },
      usageSnapshot: true,
      rateLimitRetry: true,
      reportsCost: true,
    },
  },
  {
    api: 1,
    name: 'codex',
    description: 'Drive a task as a Codex conversation',
    driver: true,
    capabilities: {
      worktrees: false,
      vision: 'flag',
      grants: { task: false, project: false },
      usageSnapshot: false,
      rateLimitRetry: false,
      reportsCost: false,
    },
    // The refusal text the daemon serves for a project-scope grant. Carried here
    // so the message doesn't silently degrade during the bootstrap window.
    projectGrantsUnsupportedReason:
      'Project permission grants are not supported for Codex tasks yet.',
  },
]

// What the current primary daemon announced. Empty until it registers.
let announced: FlowAnnouncement[] = []

export function setAnnouncedFlows(list: FlowAnnouncement[]): void {
  announced = list
}

export function clearAnnouncedFlows(): void {
  announced = []
}

// Test seam: read back exactly what was announced, before any bootstrap union.
export function announcedFlows(): FlowAnnouncement[] {
  return announced
}

// Whether the primary daemon announced this flow — the dispatch gate. Bootstrap
// entries deliberately do NOT count here: the registry union below is what the
// picker offers, and legacy flows bypass the gate because start-run still
// carries `agent` for them.
export function isAnnouncedFlow(name: string): boolean {
  return announced.some((f) => f.meta.name === name)
}

// The flows dispatchable for a project: everything the primary announced for
// this project (or globally), unioned with the legacy bootstrap entries.
//
// Invariant: anything this returns is either announced or legacy — never a name
// the picker would offer and that would then wedge on its first message.
export function flowRegistry(projectSlug: string): FlowMeta[] {
  const out: FlowMeta[] = []
  const seen = new Set<string>()
  for (const entry of announced) {
    if (entry.scope === 'project' && entry.project !== projectSlug) continue
    if (seen.has(entry.meta.name)) continue
    seen.add(entry.meta.name)
    out.push(entry.meta)
  }
  for (const meta of BOOTSTRAP_FLOWS) {
    if (seen.has(meta.name)) continue
    seen.add(meta.name)
    out.push(meta)
  }
  return out
}

// The announced meta for a flow, falling back to the frozen legacy entry so a
// claude or codex task still resolves during the bootstrap window.
export function flowMeta(name: string): FlowMeta | undefined {
  for (const entry of announced) if (entry.meta.name === name) return entry.meta
  return BOOTSTRAP_FLOWS.find((m) => m.name === name)
}

export function flowCaps(name: string): FlowCaps {
  const meta = flowMeta(name)
  if (!meta) return UNKNOWN_FLOW_CAPS
  return {
    grants: meta.capabilities.grants,
    reportsCost: meta.capabilities.reportsCost,
  }
}
