import { buildTimeline } from './timeline'
import { planTurnCollapse } from './turnCollapse'
import { taskKeyOf } from './taskRef'
import type { TaskWithProject } from './types'

// What the search box matches a task's conversation against: the text a
// freshly-opened task shows — user and hook messages, ask prompts, hook
// reports, and each agent turn collapsed (planTurnCollapse) down to its kept
// prose. Searching the whole log would match nearly every task on any word some
// tool output happened to contain. Tool calls stay out entirely — a chip is a
// step, not something the conversation says — as does the scaffolding around
// the text: headings, fold summaries, lifecycle sentences. Every agent turn
// collapses, a still-running one included. Lowercased, for a case-insensitive
// `includes`.
function conversationText(task: TaskWithProject): string {
  const parts: string[] = []
  for (const entry of buildTimeline(task, '').items) {
    if (entry.kind === 'user') parts.push(entry.item.text)
    else if (entry.kind === 'ask') parts.push(entry.ask.prompt ?? '')
    else if (entry.kind === 'hook') {
      const h = entry.hook
      parts.push(h.text ?? '', h.error ?? '', h.output ?? '')
    } else if (entry.kind === 'ride') {
      for (const seg of planTurnCollapse(entry.items).segments) {
        if (seg.hidden) continue
        for (const j of seg.indices) {
          const it = entry.items[j]
          if (it.kind === 'message') parts.push(it.text)
        }
      }
    }
  }
  // The open ask renders as its turn's footer rather than in the stream.
  const openAsk = task.items?.find(
    (it) => it.kind === 'ask' && it.state === 'open' && it.rideId,
  )
  if (openAsk?.kind === 'ask') parts.push(openAsk.prompt ?? '')
  // Newline-joined so a query can't match across two parts: the search box is
  // a single line.
  return parts.join('\n').toLowerCase()
}

// Each task's conversation text, carried from one search to the next. The
// poll hands over fresh task objects every 2s, so a task is recognized by key,
// and its text reused only while nothing can have changed it: no ride open
// (a running turn streams into its items in place) and the same item count (a
// settled task changes only by appending).
type Entry = { count: number; text: string }
let cache = new Map<string, Entry>()

// The tasks whose conversation contains `query` (already trimmed and
// lowercased). Only the tasks passed in survive into the next cache, so a
// deleted or archived task's text doesn't outlive it.
export function conversationMatches(
  tasks: TaskWithProject[],
  query: string,
): Set<TaskWithProject> {
  const next = new Map<string, Entry>()
  const hits = new Set<TaskWithProject>()
  for (const t of tasks) {
    const key = taskKeyOf(t)
    const count = t.items?.length ?? 0
    const settled = (t.rides ?? []).every((r) => r.endedAt)
    let entry = cache.get(key)
    if (!settled || entry?.count !== count) {
      entry = { count, text: conversationText(t) }
    }
    if (settled) next.set(key, entry)
    if (entry.text.includes(query)) hits.add(t)
  }
  cache = next
  return hits
}
