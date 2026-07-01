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
    ...(hasRepeat(t) ? { repeats: true } : {}),
  }
}

// Whether the task has a repeating relaunch armed — any deferred message
// carrying an --interval `repeat` spec (see the server's RepeatSpec). `lander
// list` marks such a task so a live repeating series is visible at a glance,
// without opening it.
export function hasRepeat(t) {
  return (t.scheduledMessages ?? []).some((m) => m.repeat != null)
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

// Whether a task's title or any message text contains, case-insensitively, at
// least one term from every group in `groups` (an array of term arrays) — a
// group is an OR (any term in it matches), groups themselves are ANDed. No
// groups (an empty array) matches everything. Backs `lander list --text`,
// which builds one group per occurrence of the flag, splitting each value on
// commas — so `--text foo,bar --text baz` means (foo OR bar) AND baz.
export function matchesText(task, groups) {
  if (!groups.length) return true
  const haystack = [task.title, ...(task.messages ?? []).map((m) => m.text)]
    .join('\n')
    .toLowerCase()
  return groups.every((terms) =>
    terms.some((term) => haystack.includes(term.toLowerCase())),
  )
}
