// The single owner of conversation ordering: given a task's flat `messages` and
// `events` arrays (which the server only ever appends to, never orders) plus a
// queued-follow-up list, produce the one interleaved stream the UI renders.
//
// This logic used to live inline in the App component, where it was emergent and
// untestable; it's extracted here as a pure function so the ordering rules have a
// home and a test suite. `now` is injected (rather than read from the clock) so
// the in-flight-turn behavior is deterministic under test.
//
// The inputs are structurally typed: any message with a role+createdAt and any
// event with a createdAt satisfy the constraints, so this module needn't depend
// on the App's richer Message/TaskEvent definitions — the concrete types flow
// back out through the generic, so callers keep full type information.

type Msg = { role: 'user' | 'assistant'; createdAt: string; queued?: boolean }
type Evt = { createdAt: string }

export type TimelineItem<M, E> =
  | { kind: 'message'; at: string; message: M; index: number }
  | { kind: 'event'; at: string; event: E }

// Which messages are still queued (the agent hasn't read them yet). The server
// flags them on the message (publicTask, projected from its work queue); we just
// read the flag. Callers dim these and we sink them in the timeline.
function queuedMessageIndices(task: { messages: Msg[] }): Set<number> {
  const indices = new Set<number>()
  task.messages.forEach((m, i) => {
    if (m.queued) indices.add(i)
  })
  return indices
}

export function buildTimeline<M extends Msg, E extends Evt>(
  task: { messages: M[]; events?: E[] },
  now: string,
): { items: TimelineItem<M, E>[]; queuedIndices: Set<number> } {
  const queuedIndices = queuedMessageIndices(task)
  const items: TimelineItem<M, E>[] = []

  // Messages are rendered in array order — the server only ever appends (every
  // write is a tail push stamped with the current clock), so array position is
  // already the true chronological order and we trust it rather than re-sorting.
  // The one reordering is the queued sink: a follow-up the agent hasn't read yet
  // (the trailing run of still-queued user prompts) belongs below the whole
  // conversation rather than at its enqueue time, so it's held aside here and
  // appended last.
  //
  // Each ordered item carries a `spliceAt` — the timestamp events compare
  // against to place them relative to this item. For a settled message that's
  // its own createdAt. The exception is a trailing prompt with no reply yet: it
  // sits past the last assistant message and is in flight *right now*, so it
  // anchors to `now`, keeping it below already-past events instead of floating
  // up to its enqueue time (which would, e.g., briefly jump it above a `landed`
  // event as the queue drains).
  let lastAsst = -1
  for (let i = task.messages.length - 1; i >= 0; i--) {
    if (task.messages[i].role === 'assistant') {
      lastAsst = i
      break
    }
  }
  const ordered: { item: TimelineItem<M, E>; spliceAt: string }[] = []
  const queued: TimelineItem<M, E>[] = []
  task.messages.forEach((message, i) => {
    const inFlight = i > lastAsst
    const spliceAt = inFlight ? now : message.createdAt
    const item: TimelineItem<M, E> = { kind: 'message', at: spliceAt, message, index: i }
    if (queuedIndices.has(i)) queued.push(item)
    else ordered.push({ item, spliceAt })
  })

  // Splice lifecycle events into the stream by timestamp: each event surfaces
  // just before the first item whose `spliceAt` it predates. Events are sparse
  // and mark deliberate status crossings (wedged/landed and their inverses). The
  // running `floor` keeps the comparison thresholds non-decreasing: a prompt
  // that was queued during an earlier turn has a createdAt predating that turn's
  // reply, so without the floor the greedy walk could pull an event ahead of a
  // message it should follow. (Asks don't interleave here — an open ask renders
  // as its assistant message's footer, and a resolved one as the delivered
  // message, so none needs a slot in this stream.)
  const events = [...(task.events ?? [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )
  let e = 0
  let floor = ''
  for (const { item, spliceAt } of ordered) {
    if (spliceAt > floor) floor = spliceAt
    while (e < events.length && events[e].createdAt <= floor)
      items.push({ kind: 'event', at: events[e].createdAt, event: events[e++] })
    items.push(item)
  }
  // Trailing events — including any that arrived while a follow-up sat queued —
  // surface before the queued prompts: a queued message's place in the
  // conversation is fixed by when the agent actually reads it, not when it was sent.
  while (e < events.length)
    items.push({ kind: 'event', at: events[e].createdAt, event: events[e++] })
  for (const item of queued) items.push(item)

  return { items, queuedIndices }
}
