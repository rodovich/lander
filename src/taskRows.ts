import { dateCategory } from './format'
import { isUnread } from './taskMeta'
import { taskKeyOf } from './taskRef'
import type {
  DateCategory,
  TaskView,
  TaskWithProject,
  TimeFilter,
} from './types'

// One row of the sidebar's task list: a sticky status header, a date subheader
// (when a status's tasks span more than one date bucket), or a task. Each task
// row keeps its orderedTasks index so the roving-tabindex refs and keyboard
// navigation stay aligned with that array.
export type TaskRow =
  | { kind: 'status'; key: string; status: string; first: boolean }
  | {
      kind: 'date'
      key: string
      category: DateCategory
      status: string
      first: boolean
    }
  | { kind: 'task'; key: string; task: TaskWithProject; index: number }

// Everything the list rendering needs, derived in one pass from the raw task
// list and the active filters. Pure — time enters only through `now`.
export type TaskListShape = {
  // The filtered tasks in display order (status groups, recency within each).
  orderedTasks: TaskWithProject[]
  // orderedTasks interleaved with its status/date headers.
  taskRows: TaskRow[]
  // Per-status counts for the summary row below the filter dropdown, ordered
  // left-to-right as the reverse of the list (landed, resting, riding, wedged
  // — STATUS_RANK descending). Only statuses present after filtering appear.
  statusCounts: [string, number][]
  countByStatus: Map<string, number>
  // Tasks per status+date bucket, keyed `${status}|${category}`, for the count
  // a date subheader's archive menu shows (and archives).
  countByStatusDate: Map<string, number>
  // The date buckets each status's tasks span; a status splits into date
  // subheaders only when it spans more than one.
  dateCatsByStatus: Map<string, Set<DateCategory>>
  // Start of today / this week (Sunday) in local-time ms, for date bucketing
  // and time formatting downstream.
  todayStart: number
  weekStart: number
}

// Group tasks by status — wedged (needs the user) first, then riding,
// resting, and landed last. Unknown statuses sort just ahead of landed.
const STATUS_RANK: Record<string, number> = {
  wedged: 0,
  riding: 1,
  resting: 2,
  landed: 4,
}

// Newest first, on the same timestamp the date bucketing reads. An unparseable
// one buckets as 'older', so it sorts to the back rather than wherever string
// comparison would drop it.
function byRecency(a: TaskWithProject, b: TaskWithProject): number {
  const left = Date.parse(a.updatedAt ?? a.createdAt)
  const right = Date.parse(b.updatedAt ?? b.createdAt)
  const l = Number.isNaN(left) ? -Infinity : left
  const r = Number.isNaN(right) ? -Infinity : right
  return l === r ? 0 : r - l
}

// The text a task was launched with: its first user message. A generated title
// paraphrases that prompt and drops most of its words, so searching the title
// alone misses the task whose subject was only ever stated in the prompt. Only
// the first — later replies are the conversation, not what the task is about.
// Undefined for a task with no user message yet, or one whose payload carries no
// conversation (the metadata-only projection; the displayed list is never that).
function launchMessage(task: TaskWithProject): string | undefined {
  for (const it of task.items ?? []) {
    if (it.kind === 'message' && it.role === 'user') return it.text
  }
  return undefined
}

export function buildTaskRows(
  tasks: TaskWithProject[],
  opts: {
    view: TaskView
    timeFilter: TimeFilter
    // The search box's query, already trimmed and lowercased.
    query: string
    // Tasks to keep in the Unread view even though they've been read (see the
    // sticky-unread set in App).
    stickyUnread: Set<string>
    now: Date
  },
): TaskListShape {
  const { view, timeFilter, query, stickyUnread, now } = opts

  // The update-time bound the time filter imposes, in ms (local time), or null
  // for 'any'. 'today'/'week' keep tasks at or after the start of today / this
  // week (Sunday); 'older' keeps tasks strictly before the start of this week.
  const timeCutoff = (() => {
    if (timeFilter === 'any') return null
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    if (timeFilter === 'week' || timeFilter === 'older')
      start.setDate(now.getDate() - now.getDay())
    return { ms: start.getTime(), before: timeFilter === 'older' }
  })()

  // Filter by time window, then by title and launch message (case-insensitive),
  // before grouping.
  const matchedTasks = tasks.filter((t) => {
    if (timeCutoff != null) {
      const ts = Date.parse(t.updatedAt ?? t.createdAt)
      if (!Number.isNaN(ts)) {
        if (timeCutoff.before ? ts >= timeCutoff.ms : ts < timeCutoff.ms)
          return false
      }
    }
    if (view === 'unread' && !isUnread(t) && !stickyUnread.has(taskKeyOf(t)))
      return false
    if (!query) return true
    if (t.title.toLowerCase().includes(query)) return true
    return launchMessage(t)?.toLowerCase().includes(query) ?? false
  })

  // Sort into status groups, most recent first within each. The order is
  // established here rather than inherited from the caller: the displayed list
  // arrives sorted (see loadShownTasks) but a settled local mutation puts a
  // freshly-updated task back in its old slot, and the date bucketing below
  // depends on recency order. Out of order, a status can reopen a bucket it
  // already closed and emit a second subheader carrying the same row key.
  const orderedTasks = [...matchedTasks].sort(
    (a, b) =>
      (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3) ||
      byRecency(a, b),
  )

  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime()
  const weekStart = (() => {
    const s = new Date(todayStart)
    s.setDate(s.getDate() - s.getDay())
    return s.getTime()
  })()

  const dateCatsByStatus = new Map<string, Set<DateCategory>>()
  const countByStatusDate = new Map<string, number>()
  for (const t of orderedTasks) {
    const cat = dateCategory(t.updatedAt ?? t.createdAt, todayStart, weekStart)
    const set = dateCatsByStatus.get(t.status) ?? new Set<DateCategory>()
    set.add(cat)
    dateCatsByStatus.set(t.status, set)
    const k = `${t.status}|${cat}`
    countByStatusDate.set(k, (countByStatusDate.get(k) ?? 0) + 1)
  }

  // Flatten orderedTasks into a list of rows interleaved with sticky headers:
  // a status header at every status change and, within a status whose tasks
  // span more than one date bucket, a date subheader at every bucket change.
  const taskRows: TaskRow[] = []
  let rowStatus: string | null = null
  let rowCategory: DateCategory | null = null
  orderedTasks.forEach((task, index) => {
    if (task.status !== rowStatus) {
      taskRows.push({
        kind: 'status',
        key: `status-${task.status}`,
        status: task.status,
        // The first section gets no leading gap (nothing precedes it).
        first: rowStatus === null,
      })
      rowStatus = task.status
      rowCategory = null
    }
    const category = dateCategory(
      task.updatedAt ?? task.createdAt,
      todayStart,
      weekStart,
    )
    if (
      (dateCatsByStatus.get(task.status)?.size ?? 0) > 1 &&
      category !== rowCategory
    ) {
      taskRows.push({
        kind: 'date',
        key: `date-${task.status}-${category}`,
        category,
        status: task.status,
        // The first date in a status sits directly under the status header
        // (rowCategory is reset to null at each status change).
        first: rowCategory === null,
      })
      rowCategory = category
    }
    taskRows.push({ kind: 'task', key: taskKeyOf(task), task, index })
  })

  const statusCounts = (() => {
    const counts = new Map<string, number>()
    for (const t of matchedTasks) {
      counts.set(t.status, (counts.get(t.status) ?? 0) + 1)
    }
    return [...counts.entries()].sort(
      (a, b) => (STATUS_RANK[b[0]] ?? 3) - (STATUS_RANK[a[0]] ?? 3),
    ) as [string, number][]
  })()
  const countByStatus = new Map(statusCounts)

  return {
    orderedTasks,
    taskRows,
    statusCounts,
    countByStatus,
    countByStatusDate,
    dateCatsByStatus,
    todayStart,
    weekStart,
  }
}
