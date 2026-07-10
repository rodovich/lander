// Pure helpers for the per-turn permission-review surface: which of a turn's
// tool calls were denied, distilled into grant opportunities. Kept free of React
// and I/O so the logic is unit-tested in isolation and the UI just renders it.

// The subset of a client Step these helpers read. App's Step satisfies it
// structurally, so callers pass their steps straight through.
export type BlockedStep = {
  kind: 'text' | 'tool_use' | 'tool_result'
  tool?: string
  rule?: string
  toolUseId?: string
  parentToolUseId?: string
  blocked?: boolean
}

// One denied call as a grant opportunity: `rule` is the editable settings.json
// permission string (what a grant actually persists), `tool` the bare tool name
// for display, and `key` a stable React/dedupe key.
export type BlockedRequest = { key: string; rule: string; tool: string }

// The turn's confirmed permission denials, as deduped grant opportunities. Pairs
// each blocked tool_result to its tool_use by id — subagent calls
// (parentToolUseId set) included, since their denials ride the same turn-level
// permission_denials and are just as grantable — then dedupes by rule, so the
// same denied command run three times is one row. Only steps flagged `blocked`
// (the authoritative permission_denials, reconciled at turn end) count; a plain
// isError is a failure, not a denial. A tool_use recorded before the `rule` field
// existed falls back to its bare tool name.
export function blockedRequests(steps: BlockedStep[]): BlockedRequest[] {
  const uses = new Map<string, { rule: string; tool: string }>()
  for (const s of steps) {
    if (s.kind === 'tool_use' && s.toolUseId) {
      const tool = s.tool ?? ''
      uses.set(s.toolUseId, { rule: s.rule ?? tool, tool })
    }
  }
  const out: BlockedRequest[] = []
  const seen = new Set<string>()
  for (const s of steps) {
    if (s.kind !== 'tool_result' || !s.blocked || !s.toolUseId) continue
    const use = uses.get(s.toolUseId)
    if (!use) continue // a denial with no matching call can't be identified
    if (seen.has(use.rule)) continue
    seen.add(use.rule)
    out.push({ key: use.rule, rule: use.rule, tool: use.tool })
  }
  return out
}
