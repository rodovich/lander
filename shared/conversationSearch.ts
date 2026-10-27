import type { Item, Ride } from '../src/types'
import { buildTimeline } from './timeline'
import { planTurnCollapse } from './turnCollapse'

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
// task sent, or one an event delivered, renders folded, but is searched all the
// same — it can be the task's whole brief — and opening a match unfolds it.
function conversationParts(task: { items?: Item[]; rides?: Ride[] }): Part[] {
  const parts: Part[] = []
  const push = (itemId: string, text: string | undefined) => {
    if (text) parts.push({ itemId, text })
  }
  for (const entry of buildTimeline(task, '').items) {
    if (entry.kind === 'user') push(entry.item.id, entry.item.text)
    else if (entry.kind === 'event' && entry.message)
      push(entry.message.id, entry.message.text)
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
export type ConversationIndex = {
  parts: Part[]
  lower: string[]
  starts: number[]
  joined: string
}

export function conversationIndex(task: {
  items?: Item[]
  rides?: Ride[]
}): ConversationIndex {
  const parts = conversationParts(task)
  const lower = parts.map((p) => p.text.toLowerCase())
  const starts: number[] = []
  let at = 0
  for (const l of lower) {
    starts.push(at)
    at += l.length + 1
  }
  return { parts, lower, starts, joined: lower.join('\n') }
}

// The query passed to the functions below must already be trimmed and
// lowercased.
function* matchOffsets(index: ConversationIndex, query: string) {
  if (!query) return
  for (
    let i = index.joined.indexOf(query);
    i !== -1;
    i = index.joined.indexOf(query, i + query.length)
  )
    yield i
}

export function countMatches(index: ConversationIndex, query: string): number {
  let n = 0
  for (const _ of matchOffsets(index, query)) n++
  return n
}

export function listMatches(
  index: ConversationIndex,
  query: string,
  limit: number,
): ConversationMatch[] {
  const out: ConversationMatch[] = []
  let p = 0
  let occurrence = 0
  for (const i of matchOffsets(index, query)) {
    if (out.length >= limit) break
    const prevItem = index.parts[p].itemId
    while (p + 1 < index.starts.length && index.starts[p + 1] <= i) p++
    const part = index.parts[p]
    occurrence = out.length > 0 && part.itemId === prevItem ? occurrence + 1 : 0
    // Excerpt the original text, unless lowercasing changed its length (a few
    // non-ASCII letters do) and the offsets no longer line up with it.
    const lower = index.lower[p]
    const source = lower.length === part.text.length ? part.text : lower
    out.push({
      itemId: part.itemId,
      occurrence,
      snippet: snippetAt(source, i - index.starts[p], query.length),
    })
  }
  return out
}
