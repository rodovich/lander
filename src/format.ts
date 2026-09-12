import type { DateCategory } from './types'

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

// The task list shows the full date+time for older rows but, for tasks updated
// today, just the time — the "Today" date header already supplies the day.
export function formatTaskTime(iso: string, todayStart: number): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const time = { hour: 'numeric', minute: '2-digit' } as const
  if (d.getTime() >= todayStart) return d.toLocaleTimeString([], time)
  const date = d.toLocaleDateString([], {
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    month: 'numeric',
    day: 'numeric',
  })
  return `${date} • ${d.toLocaleTimeString([], time)}`
}

// Bucket a timestamp into the list's date sections: today (>= local midnight),
// this week (>= the preceding Sunday), or older.
export function dateCategory(
  iso: string,
  todayStart: number,
  weekStart: number,
): DateCategory {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts) || ts < weekStart) return 'older'
  if (ts >= todayStart) return 'today'
  return 'week'
}

export const DATE_CATEGORY_LABELS: Record<DateCategory, string> = {
  today: 'Today',
  week: 'This week',
  older: 'Older',
}

// "/Users/me/code/myapp" -> "myapp"; the leaf is enough to tell projects apart
// in the task list without showing the whole path.
export function lastPathComponent(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

// The "project • worktree" line above the detail header's title, or null when it
// would be noise: a single project and no worktree.
//
// `worktree` is the task's recorded worktree name — what its flow's worktree
// hooks stored — and is never derived from the task's cwd. A cwd under
// `.claude/worktrees/` records only where the shell stood when the last turn
// ended; a flow that launches at the project root will not be there next turn,
// so a badge derived from it named a worktree the task had already left.
export function detailHeaderLabel({
  project,
  projectCount,
  worktree,
}: {
  project: string
  projectCount: number
  worktree?: string
}): string | null {
  if (projectCount <= 1 && !worktree) return null
  return lastPathComponent(project) + (worktree ? ` • ${worktree}` : '')
}

// Abbreviate a token count for the compact corner readout: exact below 1,000,
// then whole "k" up to a million ("35k"), then whole "M" beyond ("4M").
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${Math.round(n / 1_000_000)}M`
}

// An elapsed span for the time readouts, in at most two terms and never in a
// unit finer than the leading one earns: "12s", "1m 23s", "1h 23m". Seconds are
// noise beside an hour, so they are dropped rather than shown as a third term.
// The trailing term is kept even at zero ("1m 0s") so the readout's width
// doesn't jump as a turn crosses a boundary.
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// A dollar cost for the corner readout: two decimals up to $100 ("$0.07",
// "$1.23"), then whole dollars beyond ("$1,204") where the cents are noise.
export function formatCost(n: number): string {
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString()}`
}

// A clock time like "3:45 PM" for when a window resets. The upstream reset
// moment carries sub-second jitter around its true boundary (e.g. the 03:00:00
// reset arrives as anything from 02:59:59.98 to 03:00:00.8), so round to the
// nearest minute rather than truncating — otherwise the readout flickers
// between adjacent minutes (2:59 ↔ 3:00) as the value straddles the boundary.
export function formatResetTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  d.setSeconds(d.getSeconds() + 30)
  d.setSeconds(0, 0)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// A wedged task's session-limit reset time, formatted as a clock time, but only
// while it's still in the future — the moment a retry should wait for rather than
// firing into the same limit. Undefined once the limit has lifted (so the retry
// button reverts to retrying immediately) or when the wedge wasn't rate-limited.
export function retryResetTime(retry?: { resetsAt?: string }): string | undefined {
  const at = retry?.resetsAt
  if (!at || Date.parse(at) <= Date.now()) return undefined
  return formatResetTime(at)
}
