import {
  conversationIndex,
  countMatches,
  listMatches,
  type ConversationIndex,
  type TaskMatches,
} from '../shared/conversationSearch'
import type { Item, Ride } from './tasks'

// Indexes keyed by the parsed `items` array they were built from. The store
// hands back the same parsed record until its file changes (readTaskEntries),
// so an unchanged task reuses its index, a changed one gets a fresh array and a
// fresh index, and a record the store lets go takes its index with it.
const indexes = new WeakMap<Item[], ConversationIndex>()

function cachedIndex(task: { items?: Item[]; rides?: Ride[] }): ConversationIndex {
  if (!task.items) return conversationIndex(task)
  let index = indexes.get(task.items)
  if (!index) {
    index = conversationIndex(task)
    indexes.set(task.items, index)
  }
  return index
}

// How many of a task's matches a search lists by default.
const MATCHES_SHOWN = 3

// The tasks whose conversation contains `query` (already trimmed and
// lowercased), by id.
export function searchTasks(
  tasks: { id: string; items?: Item[]; rides?: Ride[] }[],
  query: string,
  limits: Map<string, number>,
): Record<string, TaskMatches> {
  const hits: Record<string, TaskMatches> = {}
  for (const task of tasks) {
    const index = cachedIndex(task)
    const count = countMatches(index, query)
    if (count > 0) {
      const limit = limits.get(task.id) ?? MATCHES_SHOWN
      hits[task.id] = { count, list: listMatches(index, query, limit) }
    }
  }
  return hits
}
