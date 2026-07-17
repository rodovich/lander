// The single owner of conversation ordering: given a task's flat `items` log
// (which the server only ever appends to) plus its `rides` headers, produce the
// one stream the UI renders — user bubbles, ride turns, and lifecycle events, in
// order.
//
// This logic used to live inline in the App component, where it was emergent and
// untestable; it's extracted here as a pure function so the ordering rules have a
// home and a test suite. `now` is injected (rather than read from the clock) so
// the in-flight-turn behavior is deterministic under test.
//
// With the item log, array order is already the interleave: every write is a
// tail push stamped with the current clock, and events are stored in place (they
// no longer live in a parallel array spliced at render time). So this reduces to
// three things:
//
//   - Gather each ride into ONE bubble by its id. A ride's items are usually
//     contiguous, but not always — an event recorded mid-turn (e.g. `lander
//     wedge` fires a `wedged` event while the turn keeps writing) splits them.
//     A turn is one atomic bubble regardless, so the ride's entry is pinned at
//     its first item's position and its later items fold into that same bubble;
//     the interleaving event surfaces after it, exactly as the old renderer
//     placed a turn's lifecycle events after the (atomic) assistant message.
//   - The queued sink: a follow-up the agent hasn't read yet (a trailing user
//     item the server flagged `queued`) belongs below the whole conversation
//     rather than at its enqueue position, so it's held aside and appended last.
//   - `now` anchors an open ride's entry so the in-flight turn sorts by the wall
//     clock, not the timestamp of whatever it happens to have streamed first.

import type { Item, MessageItem, EventItem, AskItem, Ride } from './types'

export type TimelineEntry =
  // A user message bubble (out of any ride). `queued` rides on the item.
  | { kind: 'user'; at: string; item: MessageItem }
  // One ride — an assistant turn — carrying all its items (flow messages and
  // tools, main-thread and subagent-nested); the renderer does the nesting and
  // collapse. `ride` is the header (open when it has no `endedAt`).
  | { kind: 'ride'; at: string; ride: Ride; items: Item[] }
  // A lifecycle event (launch, wedge, schedule, …).
  | { kind: 'event'; at: string; event: EventItem }
  // An unanchored (platform) ask, standing on its own where it was raised. Its
  // prompt is the entry's substance; the form renders only while it's open.
  | { kind: 'ask'; at: string; ask: AskItem }

export function buildTimeline(
  task: { items?: Item[]; rides?: Ride[] },
  now: string,
): { items: TimelineEntry[] } {
  const all = task.items ?? []
  const rideById = new Map((task.rides ?? []).map((r) => [r.id, r]))
  // The rides that get a turn in the stream (they produced something to
  // render). An ask anchored to one hangs there as the turn's footer; an ask
  // whose ride streamed nothing else falls back to standing alone.
  const ridesWithItems = new Set(
    all.flatMap((it) => (it.kind !== 'ask' && it.rideId ? [it.rideId] : [])),
  )

  // Hold aside the queued follow-ups (trailing user items the server flagged) so
  // they sink below everything — including any items of a still-open ride that
  // were appended after the user hit send.
  const sunk: MessageItem[] = []
  const kept: Item[] = []
  for (const it of all) {
    if (it.kind === 'message' && it.role === 'user' && it.queued) sunk.push(it)
    else kept.push(it)
  }

  const out: TimelineEntry[] = []
  // Each ride gets one entry, created (and positioned) at its first item and
  // reused for later items so an interleaving event can't split the bubble.
  const rideEntry = new Map<string, { kind: 'ride'; at: string; ride: Ride; items: Item[] }>()
  for (const it of kept) {
    if (it.kind === 'ask') {
      // An ask anchored to a ride whose turn is in the stream is that turn's
      // footer (the App renders it there), so it takes no slot of its own. Every
      // other ask — a platform ask, or converted history whose anchor didn't
      // survive — stands on its own here, where it was raised.
      //
      // It STAYS in the stream once answered or withdrawn: its prompt says what
      // happened (a kill, a daemon outage), and that's history the conversation
      // keeps even though the buttons are gone. Drop only an ask with nothing
      // left to show — no prompt to stand as a record, and no live form.
      const anchored = it.rideId !== undefined && ridesWithItems.has(it.rideId)
      if (!anchored && (it.prompt || it.state === 'open'))
        out.push({ kind: 'ask', at: it.at, ask: it })
      continue
    }
    if (it.rideId) {
      let entry = rideEntry.get(it.rideId)
      if (!entry) {
        const ride: Ride = rideById.get(it.rideId) ?? {
          id: it.rideId,
          startedAt: it.at,
        }
        entry = { kind: 'ride', at: ride.endedAt ? it.at : now, ride, items: [] }
        rideEntry.set(it.rideId, entry)
        out.push(entry)
      }
      entry.items.push(it)
      continue
    }
    if (it.kind === 'event') out.push({ kind: 'event', at: it.at, event: it })
    else if (it.kind === 'message')
      out.push({ kind: 'user', at: it.at, item: it })
  }

  for (const it of sunk) out.push({ kind: 'user', at: it.at, item: it })

  return { items: out }
}
