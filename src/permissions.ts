// Pure helpers for the per-turn permission-review surface: which of a turn's
// tool calls were denied, distilled into grant opportunities. Kept free of React
// and I/O so the logic is unit-tested in isolation and the UI just renders it.

import type { Item } from './types'

// The subset of a ride item these helpers read. A client Item satisfies it
// structurally, so callers pass a ride's items straight through.
export type BlockedItem = {
  kind: Item['kind']
  name?: string
  rule?: string
  status?: string
}

// `rule` is the permission rule a grant persists (editable in the UI before
// granting).
export type BlockedRequest = { key: string; rule: string; tool: string }

// Subagent calls (`parentId` set) stay in the list because a task or project
// grant covers subagents too.
export function blockedRequests(items: BlockedItem[]): BlockedRequest[] {
  const out: BlockedRequest[] = []
  const seen = new Set<string>()
  for (const it of items) {
    if (it.kind !== 'tool' || it.status !== 'blocked') continue
    const tool = it.name ?? ''
    const rule = it.rule ?? tool
    if (seen.has(rule)) continue
    seen.add(rule)
    out.push({ key: rule, rule, tool })
  }
  return out
}
