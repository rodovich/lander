import { openRide } from './taskMeta'
import { buildTimeline, type TimelineEntry } from '../shared/timeline'
import type { Task } from './types'

// The read marker: how far into a task's conversation the viewer has read,
// stored as `readThrough`, an ISO timestamp. Each timeline entry carries a read
// stamp (below); an entry is read when its stamp is at or before the marker, and
// the task is unread while any entry isn't. The client advances the marker a
// prefix at a time — "read up through here" — never entry by entry, so the
// server only ever stores the one timestamp.

// The moment an entry stopped changing, which is what the marker is compared
// against — or null for an entry that never counts as unread, and so neither
// holds the marker back nor moves it on:
//
//   - a settled ride stamps its end, so a turn the viewer read while it was
//     still streaming reads as unread again once it lands with more in it;
//   - the open ride is null until it lands — per-chunk churn isn't news, and
//     its landing is;
//   - a message the human typed is null — it's their own words — and so is a
//     standalone task action, which is this task acting on another;
//   - everything else (events, hooks, asks, another task's messages) stamps its
//     own moment.
export function entryReadStamp(
  entry: TimelineEntry,
  openRideId: string | undefined,
): string | null {
  switch (entry.kind) {
    case 'ride': {
      if (entry.ride.id === openRideId) return null
      if (entry.ride.endedAt) return entry.ride.endedAt
      // A ride with no header (or no end recorded) that isn't the open one: the
      // latest thing it streamed is the best stamp there is.
      let latest = ''
      for (const it of entry.items) if (it.at > latest) latest = it.at
      return latest || null
    }
    case 'user':
      return isOwnMessage(entry) ? null : entry.item.at
    case 'event':
      return entry.event.at
    case 'task-action':
      // Something this task did to another one, not news about this one.
      return null
    case 'ask':
      return entry.ask.at
    case 'hook':
      return entry.hook.at
  }
}

// A message the task's human typed: a user-role message with no other sender.
function isOwnMessage(entry: Extract<TimelineEntry, { kind: 'user' }>) {
  return entry.item.role === 'user' && !entry.item.from
}

// The task's timeline entries with their read stamps, cached per task object:
// the list asks every row whether it's unread on every render, and a poll only
// replaces the task objects that changed. `now` only positions an open ride,
// whose stamp is null regardless, so any value serves.
const stampCache = new WeakMap<object, { stamps: (string | null)[] }>()

export function readStamps(task: Task): (string | null)[] {
  const hit = stampCache.get(task)
  if (hit) return hit.stamps
  const openId = openRide(task)?.id
  const stamps = buildTimeline(task, '').items.map((e) =>
    entryReadStamp(e, openId),
  )
  stampCache.set(task, { stamps })
  return stamps
}

// The index of the first unread entry in the task's timeline, or -1 when the
// viewer is caught up. A task with no marker reads as caught up.
export function firstUnreadIndex(task: Task): number {
  const marker = task.readThrough
  if (marker == null) return -1
  return readStamps(task).findIndex((s) => s !== null && s > marker)
}

// Whether a task has unread updates. Drives the unseen dot, the kebab's "Mark
// unread" item, and the "Unread" filter view.
export function isUnread(task: Task): boolean {
  return firstUnreadIndex(task) >= 0
}

// The marker that reads the first `count` entries: the newest stamp among
// them, or '' when none of them counts. Stamps aren't strictly ordered along
// the timeline (a mid-turn event follows its ride's end stamp), so this is a
// max, not the last entry's stamp.
export function readThroughOf(stamps: (string | null)[], count: number): string {
  let latest = ''
  for (let i = 0; i < count && i < stamps.length; i++) {
    const s = stamps[i]
    if (s !== null && s > latest) latest = s
  }
  return latest
}

// The marker "Mark unread" sets: read through the human's last message, so
// everything the task did since reads as new — or, when nothing has happened
// since, everything but the last entry that counts. Null when the task has
// nothing that could be unread.
export function unreadMarker(task: Task): string | null {
  const stamps = readStamps(task)
  const entries = buildTimeline(task, '').items
  let lastOwn = -1
  entries.forEach((e, i) => {
    if (e.kind === 'user' && isOwnMessage(e)) lastOwn = i
  })
  let target = stamps.findIndex((s, i) => i > lastOwn && s !== null)
  if (target < 0)
    for (let i = stamps.length - 1; i >= 0 && target < 0; i--)
      if (stamps[i] !== null) target = i
  if (target < 0) return null
  // Read through everything before the target — unless something before it is
  // stamped later than it, which would cover it; then start from nothing.
  const before = readThroughOf(stamps, target)
  return before < stamps[target]! ? before : ''
}
