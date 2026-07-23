// Pure projection of a task onto the fields `lander list` needs to triage a
// task — id, title, status, and its created/updated timestamps — without the
// conversation. Split out from bin/lander so it's importable by a test
// without tripping the script's top-level command dispatch.
export function taskMetadata(t) {
  const relaunch = pendingRelaunch(t)
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    ...(t.scheduledFor
      ? { scheduledFor: t.scheduledFor }
      : relaunch?.deliverAt
        ? { scheduledFor: relaunch.deliverAt, relaunching: true }
        : {}),
    ...(hasRepeat(t) ? { repeats: true } : {}),
  }
}

// A pending scheduled relaunch (`lander relaunch --date/--time/--await`) armed
// on the task, if any — a deferred message flagged `relaunch`. Its `deliverAt`
// (when present) drives `scheduledFor` above so a task waiting only on a
// relaunch still shows the ⏰ in `lander list`, same as a scheduled launch/rest.
export function pendingRelaunch(t) {
  return (t.scheduledMessages ?? []).find((m) => m.relaunch)
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

// Whether a task's title or any message-item text contains, case-insensitively,
// at least one term from every group in `groups` (an array of term arrays) — a
// group is an OR (any term in it matches), groups themselves are ANDed. No
// groups (an empty array) matches everything. A term equal to the task's id
// also matches (the whole id only — no prefix or substring matching there), so
// a pasted id finds its task. Backs `lander list --text`, which builds one
// group per occurrence of the flag, splitting each value on commas — so
// `--text foo,bar --text baz` means (foo OR bar) AND baz.
export function matchesText(task, groups) {
  if (!groups.length) return true
  const haystack = [
    task.title,
    ...(task.items ?? [])
      .filter((it) => it.kind === 'message')
      .map((it) => it.text),
  ]
    .join('\n')
    .toLowerCase()
  return groups.every((terms) =>
    terms.some(
      (term) => term === task.id || haystack.includes(term.toLowerCase()),
    ),
  )
}
