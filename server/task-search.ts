import {
  countMatches,
  listMatches,
  type ConversationIndex,
  type TaskMatches,
} from '../shared/conversationSearch'

// How many of a task's matches a search lists by default.
const MATCHES_SHOWN = 3

// The tasks whose conversation contains `query` (already trimmed and
// lowercased), by id.
export function searchTasks(
  tasks: { id: string; index: ConversationIndex }[],
  query: string,
  limits: Map<string, number>,
): Record<string, TaskMatches> {
  const hits: Record<string, TaskMatches> = {}
  for (const { id, index } of tasks) {
    const count = countMatches(index, query)
    if (count > 0) {
      const limit = limits.get(id) ?? MATCHES_SHOWN
      hits[id] = { count, list: listMatches(index, query, limit) }
    }
  }
  return hits
}
