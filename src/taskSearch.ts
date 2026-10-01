import { buildTimeline } from './timeline'
import { planTurnCollapse } from './turnCollapse'
import { taskKeyOf } from './taskRef'
import type { TaskWithProject } from './types'

// One stretch of conversation text and the item that renders it, so a match
// can be traced back to its place in the conversation.
type Part = { itemId: string; text: string }

// What the search box matches a task's conversation against: the text a
// freshly-opened task shows — user and hook messages, ask prompts, hook
// reports, and each agent turn collapsed (planTurnCollapse) down to its kept
// prose. Searching the whole log would match nearly every task on any word some
// tool output happened to contain. Tool calls stay out entirely — a chip is a
// step, not something the conversation says — as does the scaffolding around
// the text: headings, fold summaries, lifecycle sentences. Every agent turn
// collapses, a still-running one included. One exception: a message another
// task sent renders folded, but is searched all the same — it can be the task's
// whole brief — and opening a match unfolds it.
function conversationParts(task: TaskWithProject): Part[] {
  const parts: Part[] = []
  const push = (itemId: string, text: string | undefined) => {
    if (text) parts.push({ itemId, text })
  }
  for (const entry of buildTimeline(task, '').items) {
    if (entry.kind === 'user') push(entry.item.id, entry.item.text)
    else if (entry.kind === 'ask') push(entry.ask.id, entry.ask.prompt)
    else if (entry.kind === 'hook') {
      const h = entry.hook
      push(h.id, h.text)
      push(h.id, h.error)
      push(h.id, h.output)
    } else if (entry.kind === 'ride') {
      for (const seg of planTurnCollapse(entry.items).segments) {
        if (seg.hidden) continue
        for (const j of seg.indices) {
          const it = entry.items[j]
          if (it.kind === 'message') push(it.id, it.text)
        }
      }
    }
  }
  // The open ask renders as its turn's footer rather than in the stream.
  const openAsk = task.items?.find(
    (it) => it.kind === 'ask' && it.state === 'open' && it.rideId,
  )
  if (openAsk?.kind === 'ask') push(openAsk.id, openAsk.prompt)
  return parts
}

// One place a query matched: the item it's in, which of that item's matches it
// is (0-based), and a one-line excerpt of the text around it.
export type ConversationMatch = {
  itemId: string
  occurrence: number
  snippet: string
}

// A task's matches for one query: how many there are, and the first `limit`
// of them, excerpted on demand — a list shows a few, and a broad query can
// match thousands.
export type ConversationMatches = {
  count: number
  list: (limit: number) => ConversationMatch[]
}

// How much text an excerpt keeps on either side of the match. The list row
// ends in an ellipsis, so the lead is short enough to keep the match in view.
const SNIPPET_LEAD = 30
const SNIPPET_TAIL = 160

// A one-line excerpt starting a little before `start`: cut at a word boundary,
// whitespace collapsed, marked with a leading ellipsis when it doesn't begin
// the text.
function snippetAt(text: string, start: number, length: number): string {
  let from = Math.max(0, start - SNIPPET_LEAD)
  if (from > 0) {
    const gap = text.slice(from, start).search(/\s/)
    if (gap !== -1) from += gap + 1
  }
  const body = text
    .slice(from, start + length + SNIPPET_TAIL)
    .replace(/\s+/g, ' ')
    .trim()
  return (from > 0 ? '…' : '') + body
}

// A task's searchable text: its parts, and their lowercased texts joined by
// newlines (so a single-line query can't match across two parts) with where
// each part begins in the join.
type Entry = {
  count: number
  parts: Part[]
  lower: string[]
  starts: number[]
  joined: string
}

function entryFor(task: TaskWithProject, count: number): Entry {
  const parts = conversationParts(task)
  const lower = parts.map((p) => p.text.toLowerCase())
  const starts: number[] = []
  let at = 0
  for (const l of lower) {
    starts.push(at)
    at += l.length + 1
  }
  return { count, parts, lower, starts, joined: lower.join('\n') }
}

function countIn(haystack: string, query: string): number {
  let n = 0
  let i = haystack.indexOf(query)
  while (i !== -1) {
    n++
    i = haystack.indexOf(query, i + query.length)
  }
  return n
}

function listIn(entry: Entry, query: string, limit: number): ConversationMatch[] {
  const out: ConversationMatch[] = []
  let p = 0
  let occurrence = 0
  for (
    let i = entry.joined.indexOf(query);
    i !== -1 && out.length < limit;
    i = entry.joined.indexOf(query, i + query.length)
  ) {
    const prevItem = entry.parts[p].itemId
    while (p + 1 < entry.starts.length && entry.starts[p + 1] <= i) p++
    const part = entry.parts[p]
    occurrence = out.length > 0 && part.itemId === prevItem ? occurrence + 1 : 0
    // Excerpt the original text, unless lowercasing changed its length (a few
    // non-ASCII letters do) and the offsets no longer line up with it.
    const lower = entry.lower[p]
    const source = lower.length === part.text.length ? part.text : lower
    out.push({
      itemId: part.itemId,
      occurrence,
      snippet: snippetAt(source, i - entry.starts[p], query.length),
    })
  }
  return out
}

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
    if (!settled || entry?.count !== count) entry = entryFor(t, count)
    if (settled) next.set(key, entry)
    const n = countIn(entry.joined, query)
    if (n > 0) {
      const e = entry
      hits.set(t, { count: n, list: (limit) => listIn(e, query, limit) })
    }
  }
  cache = next
  return hits
}
