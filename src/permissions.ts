// Pure helpers for the per-turn permission-review surface: which of a turn's
// tool calls were denied, distilled into grant opportunities. Kept free of React
// and I/O so the logic is unit-tested in isolation and the UI just renders it.

// The subset of a ride item these helpers read. A client Item satisfies it
// structurally, so callers pass a ride's items straight through.
export type BlockedItem = {
  kind: 'message' | 'tool' | 'event' | 'ask' | 'hook'
  name?: string
  rule?: string
  status?: string
}

// One denied call as a grant opportunity: `rule` is the editable settings.json
// permission string (what a grant actually persists), `tool` the bare tool name
// for display, and `key` a stable React/dedupe key.
export type BlockedRequest = { key: string; rule: string; tool: string }

// The turn's confirmed permission denials, as deduped grant opportunities: the
// tool items whose call was refused at the permission gate (`status: 'blocked'`,
// the authoritative permission_denials reconciled onto the item at turn end),
// deduped by rule so the same denied command run three times is one row.
// Subagent calls (parentId set) are included — their denials ride the same
// turn-level permission_denials and are just as grantable. A plain `failed` is a
// failure, not a denial. A tool recorded before the `rule` field existed falls
// back to its bare name.
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
