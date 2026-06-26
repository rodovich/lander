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

type Msg = { role: 'user' | 'assistant'; createdAt: string }
type Evt = { createdAt: string }

export type TimelineItem<M, E> =
  | { kind: 'message'; at: string; message: M; index: number }
  | { kind: 'event'; at: string; event: E }

// Which trailing user messages are still queued (claude hasn't read them yet).
// `queued` is drained in order, so the still-waiting ones are always the last N
// user messages — back-scan to find them. Callers dim these in the timeline.
function queuedMessageIndices(task: {
  messages: Msg[]
  queued?: string[]
}): Set<number> {
  const indices = new Set<number>()
  let remaining = task.queued?.length ?? 0
  for (let i = task.messages.length - 1; i >= 0 && remaining > 0; i--) {
    if (task.messages[i].role === 'user') {
      indices.add(i)
      remaining--
    }
  }
  return indices
}

export function buildTimeline<M extends Msg, E extends Evt>(
  task: { messages: M[]; events?: E[]; queued?: string[] },
  now: string,
): { items: TimelineItem<M, E>[]; queuedIndices: Set<number> } {
  const queuedIndices = queuedMessageIndices(task)
  const items: TimelineItem<M, E>[] = []

  // We can't just sort messages by `createdAt`: a follow-up sent while the agent
  // is spinning up (queued, and so appended to the array) gets an earlier
  // timestamp than the assistant reply it's waiting on, because that reply's
  // timestamp is stamped lazily when claude's first token arrives (see the
  // server's ensurePending). Sorting by time would then float the follow-up
  // above the response it follows. Instead we pair turns positionally: every turn
  // groups a run of consecutive user prompts with the single assistant message
  // that answers them — follow-ups that queued up while the agent ran are sent
  // as one batched turn, so a turn can hold several prompts under one reply.
  // Still-queued prompts have no assistant yet and simply trail at the end,
  // which is where they belong.
  //
  // Group messages into turns: a run of consecutive user prompts plus the one
  // assistant reply that answers them. A turn closes when its reply arrives, so
  // the next user message opens a fresh turn; a leading or doubled assistant
  // (e.g. a stray legacy message) just gets its own turn. Batched queued
  // follow-ups mean a turn can carry several prompts before its single reply.
  type Turn = { users: number[]; asst?: number }
  const turnList: Turn[] = []
  let cur: Turn | undefined
  task.messages.forEach((m, i) => {
    if (!cur || cur.asst !== undefined) {
      cur = { users: [] }
      turnList.push(cur)
    }
    if (m.role === 'user') cur.users.push(i)
    else cur.asst = i
  })

  // Queued follow-ups are held aside: claude hasn't read them yet, so they
  // belong below the whole conversation rather than at their enqueue time. Each
  // ordered item carries a `spliceAt` — the timestamp events are compared
  // against to place them relative to this item (see the splice loop).
  const ordered: { item: TimelineItem<M, E>; spliceAt: string }[] = []
  const queued: TimelineItem<M, E>[] = []
  for (const turn of turnList) {
    const ai = turn.asst
    // A turn whose prompts are all still queued (no reply yet) is one claude
    // hasn't read; it sinks to the bottom below.
    const queuedTurn =
      ai === undefined &&
      turn.users.length > 0 &&
      turn.users.every((u) => queuedIndices.has(u))
    // A turn enters the conversation when claude reads it — i.e. when its reply
    // begins streaming (the assistant's lazily-stamped createdAt) — not when the
    // prompt was typed. For a follow-up that sat queued those differ wildly, so
    // anchoring the whole turn to the read time keeps an event that fired while
    // it waited above the turn it eventually got, not below its stale enqueue
    // time. Before the reply is stamped the turn is either still queued (sunk to
    // the bottom below, so `at` is moot) or in flight right now — anchor the
    // live turn to "now" so it likewise sits below already-past events, rather
    // than briefly floating up to its enqueue time as the queue drains.
    const at =
      ai !== undefined
        ? task.messages[ai].createdAt
        : queuedTurn
          ? task.messages[turn.users[0]].createdAt
          : now
    const idxs = ai !== undefined ? [...turn.users, ai] : turn.users
    for (const i of idxs) {
      const message = task.messages[i]
      const item: TimelineItem<M, E> = { kind: 'message', at, message, index: i }
      if (queuedIndices.has(i)) {
        queued.push(item)
        continue
      }
      // A leading user prompt in a turn that already has its reply splices
      // against its *own* send time, not the turn's reply-anchored `at`. An
      // event that fired after the prompt was sent but before that reply was
      // lazily stamped (e.g. you wedge the task between sending and the first
      // token) must land *after* the prompt, not above it. The reply itself,
      // and any in-flight/queued turn (no reply yet), keep `at` so they still
      // sit below already-past events.
      const spliceAt =
        message.role === 'user' && ai !== undefined ? message.createdAt : at
      ordered.push({ item, spliceAt })
    }
  }

  // Splice lifecycle events into the turn-ordered stream by timestamp: each
  // event surfaces just before the first item whose `spliceAt` it predates.
  // Events are sparse and mark deliberate status crossings (wedged/landed and
  // their inverses). The running `floor` keeps the comparison thresholds
  // non-decreasing: a prompt that was queued during an earlier turn has a
  // createdAt predating that turn's reply, so without the floor the greedy walk
  // could pull an event ahead of a message it should follow.
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
  // conversation is fixed by when claude actually reads it, not when it was sent.
  while (e < events.length)
    items.push({ kind: 'event', at: events[e].createdAt, event: events[e++] })
  for (const item of queued) items.push(item)

  return { items, queuedIndices }
}
