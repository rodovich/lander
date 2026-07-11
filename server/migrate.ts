// The versioned task reader: converts a task record read off disk into the shape
// the current server expects. Isolated in this one module by design (see
// docs/rides-plan.md) because it is the seam that rewrites task files — store.ts
// applies it as the `revive` hook on every read, and mutateTask persists the
// converted record on its next write. For now it does a single thing; step 4
// grows it into the full v1→v2 shape migration, keeping all shape-conversion
// logic here so the two-week cleanup can remove exactly this file's transitional
// code.

// Normalize a stored status to the collapsed vocabulary (`riding | wedged |
// landed`). A legacy `resting` record predates the collapse — idle is now a
// *derived* presentation of a `riding` task with no open ride (see publicTask), so
// it is never stored. Rewrites `resting` → `riding` and returns the record;
// idempotent (a record already in the collapsed vocabulary passes through
// untouched).
export function normalizeStatus<T extends { status?: string }>(raw: T): T {
  if (raw && raw.status === 'resting') raw.status = 'riding'
  return raw
}

// The reviver store.ts applies on every task read. Named separately from
// normalizeStatus so step 4 can swap the full `migrateTask` in here without
// touching the store's call sites (the reviver plumbing is put in place now with
// this single rule).
export function reviveTask<T extends { status?: string }>(raw: T): T {
  return normalizeStatus(raw)
}

// ── v1 → v2 shape conversion ────────────────────────────────────────────────
//
// The full converter and its inverse (the legacy projection). Pure, no I/O, and
// unwired in step 3 — nothing calls migrateTask outside tests until step 4 makes
// it the store reviver. Together they let the server hold v2 storage while still
// serving the v1 public shape (dual-shape serving); the round-trip
// toLegacyShape(migrateTask(v1)) reproduces v1's public messages/events (the test
// harness's load-bearing property). See docs/rides-plan.md step 3.

import type { Step, Usage } from './stream'
import type {
  Message,
  TaskEvent,
  Ride,
  Item,
  MessageItem,
  ToolItem,
  EventItem,
} from './tasks'
import type { Ask } from './asks'

// The v1 stored slice the converter reads (everything else on the record is
// carried through untouched).
type V1Task = {
  shape?: number
  messages?: Message[]
  events?: TaskEvent[]
  asks?: Ask[]
  runId?: string
}

// The tool_result outcome → the folded item status.
function resultStatus(step: Step): ToolItem['status'] {
  return step.blocked ? 'blocked' : step.isError ? 'failed' : 'ok'
}

// Convert a v1 record (raw, as parsed off disk) to v2 in place: synthesize a ride
// per assistant message, expand steps into the item log, splice events in by the
// same floor rule the renderer uses, carry open asks as standalone items, and
// stamp `shape: 2`. Idempotent: a record already at shape 2 passes straight
// through. Everything not named here (runId/runCursor, queued, artifacts registry,
// sessionId, …) is left untouched. Pure apart from mutating the passed record.
export function migrateTask<T extends object>(raw: T): T {
  const t = raw as T & V1Task
  if (t.shape === 2) return raw
  // A v1 record may still carry the legacy `resting` status; collapse it too, so
  // migrateTask is a superset of the step-2 reviver (step 4 swaps it in wholesale).
  normalizeStatus(t as { status?: string })

  const messages = t.messages ?? []
  const events = t.events ?? []
  const asks = t.asks ?? []
  const runId = t.runId

  // Id minters. Message/event items mint `itm-<epoch36>-<seq>` (the nextAskId
  // scheme); settled rides mint `ride-<epoch36>-<n>`. Sequential counters keep a
  // single conversion's ids unique and deterministic (idempotence rides on the
  // shape-2 short-circuit above, not on id stability across separate calls).
  let itemSeq = 0
  const mintItemId = (at: string) =>
    `itm-${Math.floor(Date.parse(at) || 0).toString(36)}-${itemSeq++}`
  let rideSeq = 0
  const mintRideId = (startedAt: string) =>
    `ride-${Math.floor(Date.parse(startedAt) || 0).toString(36)}-${rideSeq++}`

  const rides: Ride[] = []

  // Convert one assistant message → a ride plus its items.
  const convertAssistant = (msg: Message): Item[] => {
    const steps = msg.steps ?? []
    // The mid-flight case: a still-pending message on a task with a live runId
    // becomes an *open* ride (id = runId), so a run that streamed under the old
    // shape finishes under the new one. Everything else is settled history.
    const isOpen = msg.pending === true && typeof runId === 'string'
    const rideId = isOpen ? (runId as string) : mintRideId(msg.createdAt)
    const endedAt = steps.length
      ? steps[steps.length - 1].createdAt
      : msg.createdAt
    const ride: Ride = isOpen
      ? { id: rideId, startedAt: msg.createdAt }
      : { id: rideId, startedAt: msg.createdAt, endedAt, outcome: 'done' }
    if (msg.usage) ride.usage = msg.usage
    rides.push(ride)

    const items: Item[] = []
    const toolById = new Map<string, ToolItem>()
    for (const s of steps) {
      if (s.kind === 'tool_use') {
        const item: ToolItem = {
          id: s.toolUseId ?? mintItemId(s.createdAt),
          at: s.createdAt,
          rideId,
          kind: 'tool',
          name: s.tool ?? '',
          input: s.input ?? '',
          status: 'running',
          ...(s.inputFull ? { inputFull: s.inputFull } : {}),
          ...(s.rule ? { rule: s.rule } : {}),
          ...(s.edits ? { edits: s.edits } : {}),
          ...(s.inferenceId ? { groupId: s.inferenceId } : {}),
          ...(s.parentToolUseId ? { parentId: s.parentToolUseId } : {}),
        }
        items.push(item)
        if (s.toolUseId) toolById.set(s.toolUseId, item)
      } else if (s.kind === 'tool_result') {
        const target = s.toolUseId ? toolById.get(s.toolUseId) : undefined
        if (target) {
          if (s.text !== undefined) target.output = s.text
          target.status = resultStatus(s)
        } else {
          // Orphan result (no matching tool_use — shouldn't happen, but old files
          // are wild): keep it as a standalone tool item rather than dropping it.
          items.push({
            id: s.toolUseId ?? mintItemId(s.createdAt),
            at: s.createdAt,
            rideId,
            kind: 'tool',
            name: '',
            input: '',
            status: resultStatus(s),
            ...(s.text !== undefined ? { output: s.text } : {}),
            ...(s.parentToolUseId ? { parentId: s.parentToolUseId } : {}),
          })
        }
      } else {
        // text step → flow message item (a subagent's prose nests like its tools).
        items.push({
          id: mintItemId(s.createdAt),
          at: s.createdAt,
          rideId,
          kind: 'message',
          role: 'flow',
          text: s.text ?? '',
          ...(s.inferenceId ? { groupId: s.inferenceId } : {}),
          ...(s.parentToolUseId ? { parentId: s.parentToolUseId } : {}),
        })
      }
    }

    const lastMainFlow = () =>
      [...items]
        .reverse()
        .find(
          (it): it is MessageItem =>
            it.kind === 'message' && it.parentId === undefined,
        )

    // Reconcile Message.text: if it differs from the last main-agent flow item's
    // text (stepless legacy, applyDone error text, codex), append one final flow
    // item carrying it. If it matches (the common case — finalText mirrors the
    // last text step), nothing, so no duplicate.
    const finalText = msg.text ?? ''
    if (finalText && lastMainFlow()?.text !== finalText) {
      items.push({
        id: mintItemId(endedAt),
        at: endedAt,
        rideId,
        kind: 'message',
        role: 'flow',
        text: finalText,
      })
    }

    // Artifact refs carry onto the last main-agent flow item (creating an empty
    // one only if the turn produced no prose at all).
    if (msg.artifacts?.length) {
      let host = lastMainFlow()
      if (!host) {
        host = {
          id: mintItemId(endedAt),
          at: endedAt,
          rideId,
          kind: 'message',
          role: 'flow',
          text: finalText,
        }
        items.push(host)
      }
      host.artifacts = msg.artifacts
    }

    return items
  }

  const convertUser = (msg: Message): MessageItem => ({
    id: mintItemId(msg.createdAt),
    at: msg.createdAt,
    kind: 'message',
    role: 'user',
    text: msg.text ?? '',
    ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
  })

  const convertEvent = (ev: TaskEvent): EventItem => ({
    id: mintItemId(ev.createdAt),
    at: ev.createdAt,
    kind: 'event',
    eventKind: ev.kind,
    ...(ev.title !== undefined ? { title: ev.title } : {}),
    ...(ev.scheduledFor !== undefined ? { scheduledFor: ev.scheduledFor } : {}),
    ...(ev.awaiting !== undefined ? { awaiting: ev.awaiting } : {}),
  })

  // Expand each message into its item group, in array order (which the server
  // wrote in true chronological order — it only ever appends). Queued follow-ups
  // stay in place; buildTimeline still owns the render-time queued sink.
  const groups = messages.map((m) => ({
    spliceAt: m.createdAt,
    items: m.role === 'assistant' ? convertAssistant(m) : [convertUser(m)],
  }))

  // Splice events into the log by timestamp, using buildTimeline's floor rule
  // (src/timeline.ts): each event surfaces just before the first group whose
  // spliceAt it predates, with a non-decreasing floor so a follow-up that was
  // queued during an earlier turn can't pull an event ahead of a later reply.
  const sortedEvents = [...events].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )
  const items: Item[] = []
  let e = 0
  let floor = ''
  for (const g of groups) {
    if (g.spliceAt > floor) floor = g.spliceAt
    while (e < sortedEvents.length && sortedEvents[e].createdAt <= floor)
      items.push(convertEvent(sortedEvents[e++]))
    items.push(...g.items)
  }
  while (e < sortedEvents.length) items.push(convertEvent(sortedEvents[e++]))

  // Asks, lossily: carry each *open* ask as a standalone ask item (unanchored —
  // historical fidelity isn't required); drop answered/withdrawn asks outright.
  for (const ask of asks) {
    if (ask.state !== 'open') continue
    items.push({
      id: ask.id,
      at: ask.createdAt,
      kind: 'ask',
      form: ask.form,
      blocking: ask.blocking,
      state: ask.state,
      ...(ask.prompt !== undefined ? { prompt: ask.prompt } : {}),
      ...(ask.answer !== undefined ? { answer: ask.answer } : {}),
      ...(ask.origin !== undefined ? { origin: ask.origin } : {}),
    })
  }

  const out = t as T & {
    shape: number
    rides: Ride[]
    items: Item[]
    messages?: unknown
    events?: unknown
    asks?: unknown
  }
  out.rides = rides
  out.items = items
  out.shape = 2
  delete out.messages
  delete out.events
  delete out.asks
  return raw
}

// The inverse projection: a v2 record → the v1 public `messages`/`events`/`asks`
// arrays, so the currently-loaded UI and the CLI keep working while storage is v2
// (dual-shape serving, step 4). Steps re-split into use/result pairs, each ride →
// one assistant message (open ride → `pending: true`), events → the flat events
// array, and open ask items → the asks array. Byte-faithful for the fields the UI
// renders; the tool_result timestamp (folded away) and the finalText/last-text
// duplication are render-equivalent, not byte-identical (see migrate.test.ts).
// Kept even after the UI flip — it is the converter's test harness (round-trip).
export function toLegacyShape(task: {
  rides?: Ride[]
  items?: Item[]
}): { messages: Message[]; events: TaskEvent[]; asks: Ask[] } {
  const items = task.items ?? []
  const rideById = new Map((task.rides ?? []).map((r) => [r.id, r]))
  const messages: Message[] = []
  const events: TaskEvent[] = []
  const asks: Ask[] = []

  const fromRide = (rideId: string, group: Item[]): Message => {
    const ride = rideById.get(rideId)
    const steps: Step[] = []
    for (const it of group) {
      if (it.kind === 'tool') {
        steps.push({
          kind: 'tool_use',
          tool: it.name,
          input: it.input,
          toolUseId: it.id,
          ...(it.inputFull ? { inputFull: it.inputFull } : {}),
          ...(it.groupId ? { inferenceId: it.groupId } : {}),
          ...(it.parentId ? { parentToolUseId: it.parentId } : {}),
          ...(it.rule ? { rule: it.rule } : {}),
          ...(it.edits ? { edits: it.edits } : {}),
          createdAt: it.at,
        })
        // Emit the paired result only once the tool has landed (an open ride's
        // still-running tool has no result yet — just the use step, as in v1).
        if (it.status !== 'running' || it.output !== undefined) {
          steps.push({
            kind: 'tool_result',
            toolUseId: it.id,
            ...(it.output !== undefined ? { text: it.output } : {}),
            ...(it.parentId ? { parentToolUseId: it.parentId } : {}),
            ...(it.status === 'failed' || it.status === 'blocked'
              ? { isError: true }
              : {}),
            ...(it.status === 'blocked' ? { blocked: true } : {}),
            // The result's own timestamp was folded away; the use step's stands in.
            createdAt: it.at,
          })
        }
      } else if (it.kind === 'message') {
        steps.push({
          kind: 'text',
          text: it.text,
          ...(it.groupId ? { inferenceId: it.groupId } : {}),
          ...(it.parentId ? { parentToolUseId: it.parentId } : {}),
          createdAt: it.at,
        })
      }
    }
    const lastMainFlow = [...group]
      .reverse()
      .find(
        (it): it is MessageItem =>
          it.kind === 'message' && it.parentId === undefined,
      )
    const artifactHost = [...group]
      .reverse()
      .find(
        (it): it is MessageItem =>
          it.kind === 'message' && !!it.artifacts?.length,
      )
    const msg: Message = {
      role: 'assistant',
      text: lastMainFlow?.text ?? '',
      createdAt: ride?.startedAt ?? group[0]?.at ?? '',
      steps,
    }
    if (ride?.usage) msg.usage = ride.usage
    if (ride && !ride.endedAt) msg.pending = true
    if (artifactHost?.artifacts) msg.artifacts = artifactHost.artifacts
    return msg
  }

  for (let i = 0; i < items.length; ) {
    const it = items[i]
    if (it.kind === 'event') {
      events.push({
        kind: it.eventKind,
        createdAt: it.at,
        ...(it.title !== undefined ? { title: it.title } : {}),
        ...(it.scheduledFor !== undefined
          ? { scheduledFor: it.scheduledFor }
          : {}),
        ...(it.awaiting !== undefined ? { awaiting: it.awaiting } : {}),
      })
      i++
    } else if (it.kind === 'ask') {
      asks.push({
        id: it.id,
        createdAt: it.at,
        form: it.form,
        blocking: it.blocking,
        state: it.state,
        ...(it.prompt !== undefined ? { prompt: it.prompt } : {}),
        ...(it.answer !== undefined ? { answer: it.answer } : {}),
        ...(it.origin !== undefined ? { origin: it.origin } : {}),
      })
      i++
    } else if (it.kind === 'message' && it.role === 'user') {
      messages.push({
        role: 'user',
        text: it.text,
        createdAt: it.at,
        ...(it.attachments?.length ? { attachments: it.attachments } : {}),
      })
      i++
    } else if (it.rideId) {
      // A ride's items are contiguous (events splice only at group boundaries);
      // collect the whole run and rebuild its one assistant message.
      const rideId = it.rideId
      const group: Item[] = []
      while (i < items.length && items[i].rideId === rideId) group.push(items[i++])
      messages.push(fromRide(rideId, group))
    } else {
      // A flow message with no rideId shouldn't occur; keep it as an assistant
      // message rather than dropping content.
      messages.push({
        role: 'assistant',
        text: it.kind === 'message' ? it.text : '',
        createdAt: it.at,
        steps: [],
      })
      i++
    }
  }

  return { messages, events, asks }
}
