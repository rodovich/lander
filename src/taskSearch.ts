import {
  conversationIndex,
  countMatches,
  listMatches,
  type ConversationIndex,
  type ConversationMatch,
} from '../shared/conversationSearch'
import { taskKeyOf } from './taskRef'
import type { TaskWithProject } from './types'

export type { ConversationMatch }

// A task's matches for one query: how many there are, and the first `limit`
// of them, excerpted on demand — a list shows a few, and a broad query can
// match thousands.
export type ConversationMatches = {
  count: number
  list: (limit: number) => ConversationMatch[]
}

type Entry = { count: number; index: ConversationIndex }

// Each task's searchable text, carried from one search to the next. The poll
// hands over fresh task objects every 2s, so a task is recognized by key, and
// its text reused only while nothing can have changed it: no ride open (a
// running turn streams into its items in place) and the same item count (a
// settled task changes only by appending).
let cache = new Map<string, Entry>()

// The tasks whose conversation contains `query` (already trimmed and
// lowercased), with their matches. Only the tasks passed in survive into the
// next cache, so a deleted or archived task's text doesn't outlive it.
export function conversationMatches(
  tasks: TaskWithProject[],
  query: string,
): Map<TaskWithProject, ConversationMatches> {
  const next = new Map<string, Entry>()
  const hits = new Map<TaskWithProject, ConversationMatches>()
  for (const t of tasks) {
    const key = taskKeyOf(t)
    const count = t.items?.length ?? 0
    const settled = (t.rides ?? []).every((r) => r.endedAt)
    let entry = cache.get(key)
    if (!settled || entry?.count !== count)
      entry = { count, index: conversationIndex(t) }
    if (settled) next.set(key, entry)
    const n = countMatches(entry.index, query)
    if (n > 0) {
      const index = entry.index
      hits.set(t, { count: n, list: (limit) => listMatches(index, query, limit) })
    }
  }
  cache = next
  return hits
}
