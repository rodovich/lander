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

// The name of the git worktree a task's cwd sits in, or null when it's not in
// one. Claude Code's `--worktree` flag roots worktrees at `.claude/worktrees/
// <name>`, so the name is the path segment right after that marker (the cwd may
// be a deeper subdirectory of the worktree, hence the index lookup rather than
// a plain last component).
export function worktreeName(cwd: string | undefined): string | null {
  if (!cwd) return null
  const parts = cwd.split('/').filter(Boolean)
  const i = parts.lastIndexOf('worktrees')
  if (i < 1 || parts[i - 1] !== '.claude') return null
  return parts[i + 1] ?? null
}

// Abbreviate a token count for the compact corner readout: exact below 1,000,
// then whole "k" up to a million ("35k"), then whole "M" beyond ("4M").
export function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${Math.round(n / 1_000_000)}M`
}

// A dollar cost for the corner readout: two decimals up to $100 ("$0.07",
// "$1.23"), then whole dollars beyond ("$1,204") where the cents are noise.
export function formatCost(n: number): string {
  if (n < 100) return `$${n.toFixed(2)}`
  return `$${Math.round(n).toLocaleString()}`
}

// The selected task's project is the first path segment, e.g.
// "/users-me-code-app/task1/" -> "users-me-code-app". Empty on "/".
export function slugFromPath(): string {
  return window.location.pathname.split('/').filter(Boolean)[0] ?? ''
}

// The selected task's id is the second path segment, e.g.
// "/users-me-code-app/task1/" -> "task1". Empty when no task is in the URL.
export function taskIdFromPath(): string {
  return window.location.pathname.split('/').filter(Boolean)[1] ?? ''
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
