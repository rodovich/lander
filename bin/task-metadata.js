// Pure projection of a task onto the fields `lander list` needs to triage a
// task — id, title, status, and its created/updated timestamps — without the
// conversation. Split out from bin/lander so it's importable by a test
// without tripping the script's top-level command dispatch.
export function taskMetadata(t) {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ...(t.scheduledFor ? { scheduledFor: t.scheduledFor } : {}),
  }
}

// Whether a task's createdAt falls within [since, until] (each an epoch-ms
// bound, inclusive, or undefined for an open end) — backs `lander list`'s
// --since/--until filters.
export function inDateRange(createdAt, { since, until } = {}) {
  const ms = Date.parse(createdAt)
  if (since != null && ms < since) return false
  if (until != null && ms > until) return false
  return true
}
