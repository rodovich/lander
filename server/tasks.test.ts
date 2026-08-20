import { describe, it, expect } from 'vitest'
import {
  publicTask,
  taskSummary,
  taskFlow,
  latestUpdateAt,
  recordStatusTransition,
  recordArtifactOnMessage,
  lastTurnPrompts,
  turnAttachments,
  deliverQueuedBatch,
  worktreeName,
  applyRelaunch,
  applyDueMessages,
  armScheduledRelaunch,
  nextRepeatMessage,
  openRide,
  startRide,
  closeRide,
  nextItemId,
  pushUserItem,
  pushFlowItem,
  pushEventItem,
  lastFlowItem,
  userItems,
  eventItems,
  taskSessionId,
  setTaskSessionId,
  taskTurnContext,
  setTaskTurnContext,
  clearTaskThread,
  recordAssistantError,
  recordRideEnded,
  acceptHookAction,
  dropHookAction,
  HOOK_ACTION_BOUND,
  MAX_HOOK_ACTIONS,
  MAX_PENDING_HOOKS,
  type HookAction,
  type Item,
  type MessageItem,
  type PendingHook,
  type ScheduledMessage,
  type Ride,
} from './tasks'
import { askItems, createAsk } from './asks'
import type { RevivedMarker } from './protocol'
import { buildTimeline } from '../src/timeline'

const AT = '2026-01-01T00:00:00.000Z'
const later = (n: number) => `2026-01-01T00:0${n}:00.000Z`

const userItem = (text: string, at = AT, over: Partial<MessageItem> = {}): MessageItem => ({
  id: `u-${text}`,
  at,
  kind: 'message',
  role: 'user',
  text,
  ...over,
})
const flowItem = (text: string, rideId: string, at = AT): MessageItem => ({
  id: `f-${text}`,
  at,
  rideId,
  kind: 'message',
  role: 'flow',
  text,
})
const hookItem = (text: string, at = AT, path = '.lander/hooks/a/any/s.js'): MessageItem => ({
  id: `h-${text}`,
  at,
  kind: 'message',
  role: 'hook',
  text,
  from: { hook: 's', path, fireId: 'fire-1' },
})

describe('item builders', () => {
  it('nextItemId mints itm-<epoch36>-<count>', () => {
    expect(nextItemId({ items: [] }, AT)).toMatch(/^itm-[a-z0-9]+-0$/)
    expect(nextItemId({ items: [userItem('a'), userItem('b')] }, AT)).toMatch(/-2$/)
  })

  it('pushUserItem / pushFlowItem / pushEventItem append to the log', () => {
    const t: { items?: Item[] } = {}
    pushUserItem(t, 'hi', AT, { attachments: [{ id: 'a', name: 'f', mime: 'text/plain', size: 1 }] })
    pushFlowItem(t, 'r1', 'reply', later(1))
    pushEventItem(t, { eventKind: 'wedged', title: 'T' }, later(2))
    expect(t.items!.map((i) => i.kind)).toEqual(['message', 'message', 'event'])
    expect((t.items![0] as MessageItem).attachments).toHaveLength(1)
    expect((t.items![1] as MessageItem).rideId).toBe('r1')
  })

  it('lastFlowItem returns the last main-agent flow item, optionally scoped to a ride', () => {
    const t = {
      items: [
        flowItem('a', 'r1'),
        { ...flowItem('sub', 'r1'), id: 'sub', parentId: 'spawn' } as MessageItem,
        flowItem('b', 'r1', later(1)),
        flowItem('c', 'r2', later(2)),
      ],
    }
    expect(lastFlowItem(t)?.text).toBe('c')
    expect(lastFlowItem(t, 'r1')?.text).toBe('b') // skips the nested (parentId) prose
  })

  it('userItems / eventItems filter the log', () => {
    const t = {
      items: [userItem('u1'), flowItem('f', 'r1'), pushEv(), userItem('u2')],
    }
    expect(userItems(t).map((u) => u.text)).toEqual(['u1', 'u2'])
    expect(eventItems(t).map((e) => e.eventKind)).toEqual(['launched'])
  })
})

function pushEv(): Item {
  return { id: 'e', at: AT, kind: 'event', eventKind: 'launched', title: 'T' }
}

describe('taskFlow', () => {
  it('prefers a stored flow over the legacy agent', () => {
    expect(taskFlow({ flow: 'open-pr', agent: 'claude' })).toBe('open-pr')
  })

  it('reads a pre-step-4 task’s agent as its flow — permanently', () => {
    // Not a migration window: nothing rewrites these tasks, so this fallback
    // stays load-bearing forever.
    expect(taskFlow({ agent: 'codex' })).toBe('codex')
  })

  it('falls back to the legacy flow when a task names neither', () => {
    expect(taskFlow({})).toBe('claude')
  })
})

describe('publicTask', () => {
  it('derives and serves the flow name', () => {
    expect(publicTask({ id: 's', agent: 'codex' }).flow).toBe('codex')
    expect(publicTask({ id: 's', flow: 'open-pr' }).flow).toBe('open-pr')
    // A structural fixture with no provider field at all still gets one.
    expect(publicTask({ id: 's' }).flow).toBe('claude')
  })

  it('strips token, runId, runCursor and the retry stash', () => {
    const out = publicTask({
      id: 's',
      title: 't',
      status: 'landed',
      items: [],
      token: 'secret',
      runId: 'r1',
      runCursor: 42,
      retry: { committed: true, prompts: ['x'] },
      allowEdits: true,
    })
    expect('token' in out).toBe(false)
    expect('runId' in out).toBe(false)
    expect('runCursor' in out).toBe(false)
    expect('retry' in out).toBe(false)
  })

  // The action record answers exactly one question — how much of the bound is
  // left — and it cannot answer it without the reset stamp, which is stripped.
  // Serving the list alone would be a promise worth nothing. `pendingHooks` is
  // deliberately not in this set: it is self-contained, and "was a fire ever
  // recorded" is the first thing anyone debugging a hook asks.
  it('strips the hook bookkeeping but keeps pendingHooks', () => {
    const out = publicTask({
      id: 's',
      title: 't',
      status: 'riding',
      items: [],
      hookFireSeq: 3,
      hookActionsResetAt: AT,
      hookActions: [{ hook: 'h', fireId: 'f', key: 'k', kind: 'nudge' as const, at: AT }],
      pendingHooks: [{ id: 'fire-1-x', trigger: 'ride-ended', by: 'agent', at: AT }],
    })
    expect('hookActions' in out).toBe(false)
    expect('hookActionsResetAt' in out).toBe(false)
    expect('hookFireSeq' in out).toBe(false)
    expect('pendingHooks' in out).toBe(true)
  })

  it('serves the native item log (no legacy messages/events/asks projection)', () => {
    const items: Item[] = [
      { id: 'e', at: AT, kind: 'event', eventKind: 'launched', title: 't' },
      userItem('do it', later(1)),
      flowItem('done', 'r1', later(2)),
    ]
    const out = publicTask({
      id: 's',
      status: 'riding',
      items,
      rides: [{ id: 'r1', startedAt: later(2), endedAt: later(2), outcome: 'done' }],
    }) as { items?: Item[]; messages?: unknown; events?: unknown; asks?: unknown }
    // Native items pass through unchanged.
    expect(out.items).toHaveLength(3)
    expect(out.items!.map((i) => i.kind)).toEqual(['event', 'message', 'message'])
    // The legacy projection is gone from the wire.
    expect('messages' in out).toBe(false)
    expect('events' in out).toBe(false)
    expect('asks' in out).toBe(false)
  })

  it('flags queued on the trailing user item', () => {
    const items: Item[] = [userItem('p1', AT), flowItem('r', 'r1', later(1)), userItem('p2', later(2))]
    const out = publicTask({
      id: 's',
      status: 'riding',
      items,
      rides: [{ id: 'r1', startedAt: later(1), endedAt: later(1), outcome: 'done' }],
      queued: ['p2'],
    }) as { items?: (MessageItem & { queued?: boolean })[] }
    expect(out.items!.filter((i) => i.queued).map((i) => (i.kind === 'message' ? i.text : ''))).toEqual(['p2'])
  })

  // Status collapse: stored riding|wedged|landed, served with today's four words.
  const served = (over: Record<string, unknown>) =>
    (publicTask({ id: 's', status: 'riding', items: [], ...over }) as { status?: string }).status
  const openR: Ride = { id: 'r1', startedAt: AT }
  const closedR: Ride = { id: 'r0', startedAt: AT, endedAt: later(1), outcome: 'done' }

  it('serves riding with an open ride or a runId, resting otherwise', () => {
    expect(served({ rides: [openR] })).toBe('riding')
    expect(served({ runId: 'r1' })).toBe('riding')
    expect(served({})).toBe('resting')
    expect(served({ rides: [closedR] })).toBe('resting')
  })

  it('serves wedged/landed as stored', () => {
    expect((publicTask({ id: 's', status: 'wedged', items: [], rides: [openR] }) as { status?: string }).status).toBe('wedged')
    expect((publicTask({ id: 's', status: 'landed', items: [] }) as { status?: string }).status).toBe('landed')
  })

  it('derives grant capabilities from the flow’s announced meta', () => {
    expect(publicTask({ id: 's', status: 'riding', items: [], agent: 'claude' }).grants).toEqual({ task: true, project: true })
    expect(publicTask({ id: 's', status: 'riding', items: [], agent: 'codex' }).grants).toEqual({ task: false, project: false })
    expect(publicTask({ id: 's', status: 'riding', items: [], flow: 'codex' }).grants).toEqual({ task: false, project: false })
  })

  it('derives the cost-reporting capability from the flow’s announced meta', () => {
    expect(publicTask({ id: 's', status: 'riding', items: [], agent: 'claude' }).reportsCost).toBe(true)
    expect(publicTask({ id: 's', status: 'riding', items: [], agent: 'codex' }).reportsCost).toBe(false)
  })

  it('gives a provider-less fixture the legacy flow’s capabilities', () => {
    // Deliberate change from the agentGrantCaps era, where caps attached only
    // `if (agent)` so a structural fixture received none. taskFlow() always
    // resolves to at least LEGACY_FLOW, so they now attach here too.
    const out = publicTask({ id: 's', status: 'riding', items: [] })
    expect(out.flow).toBe('claude')
    expect(out.grants).toEqual({ task: true, project: true })
    expect(out.reportsCost).toBe(true)
  })

  it('degrades an unknown flow to the conservative floor', () => {
    // Not "fully capable": a flow the server has never heard of must not be
    // advertised as honoring a grant scope it may ignore.
    const out = publicTask({ id: 's', status: 'riding', items: [], flow: 'who-dis' })
    expect(out.grants).toEqual({ task: false, project: false })
    expect(out.reportsCost).toBe(false)
  })

  it('lets a caller pin caps explicitly', () => {
    const out = publicTask(
      { id: 's', status: 'riding', items: [], agent: 'claude' },
      { caps: { grants: { task: false, project: true }, reportsCost: false } },
    )
    expect(out.grants).toEqual({ task: false, project: true })
    expect(out.reportsCost).toBe(false)
  })
})

describe('taskSummary', () => {
  const openR2: Ride = { id: 'r1', startedAt: AT }
  const closedR2: Ride = { id: 'r0', startedAt: AT, endedAt: later(1), outcome: 'done' }

  it('serves the status publicTask derives from the rides it then drops', () => {
    // The whole reason the projection runs full-then-drop: a stored `riding`
    // task is served `riding` only while a ride is open, and the summary has no
    // rides left to derive that from.
    const riding = taskSummary({ id: 's', status: 'riding', items: [], rides: [openR2] })
    expect((riding as { status?: string }).status).toBe('riding')
    const idle = taskSummary({ id: 's', status: 'riding', items: [], rides: [closedR2] })
    expect((idle as { status?: string }).status).toBe('resting')
  })

  it('omits items and rides, and strips everything publicTask strips', () => {
    const out = taskSummary({
      id: 's',
      title: 't',
      status: 'riding',
      items: [userItem('hi')],
      rides: [openR2],
      token: 'secret',
      runId: 'r1',
      runCursor: 42,
      retry: { committed: true, prompts: ['x'] },
      flowState: { k: 1 },
      flowStateRev: 3,
      allowEdits: true,
    })
    expect('items' in out).toBe(false)
    expect('rides' in out).toBe(false)
    expect('token' in out).toBe(false)
    expect('runId' in out).toBe(false)
    expect('runCursor' in out).toBe(false)
    expect('retry' in out).toBe(false)
    expect('flowState' in out).toBe(false)
    expect('flowStateRev' in out).toBe(false)
    // Everything else the list reads survives, capability flags included.
    expect(out).toMatchObject({ id: 's', title: 't', allowEdits: true, flow: 'claude' })
  })

  it('projects scheduledMessages to the schedule, keeping the index and dropping the text', () => {
    const scheduled: ScheduledMessage[] = [
      { text: 'plain deferred send', deliverAt: later(1) },
      { text: 'waiting on siblings', waitFor: ['a', 'b'] },
      {
        text: 'repeating relaunch',
        deliverAt: later(2),
        relaunch: true,
        repeat: { interval: 60, remaining: 2 },
      },
    ]
    const out = taskSummary({
      id: 's',
      status: 'riding',
      items: [],
      scheduledMessages: scheduled,
    }) as { scheduledMessages?: ScheduledMessage[] }
    // Index-preserving: the row and bin/task-metadata.js read entries
    // positionally, so the middle entry keeps its slot even with nothing left
    // in it.
    expect(out.scheduledMessages).toEqual([
      { deliverAt: later(1) },
      {},
      { deliverAt: later(2), relaunch: true, repeat: { interval: 60, remaining: 2 } },
    ])
    expect(out.scheduledMessages!.some((m) => 'text' in m)).toBe(false)
    expect(JSON.stringify(out)).not.toContain('deferred send')
  })

  it('leaves scheduledMessages absent when the task has none', () => {
    expect('scheduledMessages' in taskSummary({ id: 's', status: 'riding', items: [] })).toBe(
      false,
    )
  })
})

describe('latestUpdateAt', () => {
  it('takes the newest completed item and ride endedAt, skipping open-ride items', () => {
    const t = {
      items: [
        userItem('u', AT),
        { id: 'e', at: later(1), kind: 'event', eventKind: 'launched' } as Item,
        flowItem('open', 'open-ride', later(9)), // in the open ride — skipped
      ],
      rides: [
        { id: 'closed', startedAt: AT, endedAt: later(2), outcome: 'done' } as Ride,
        { id: 'open-ride', startedAt: later(5) } as Ride,
      ],
    }
    expect(latestUpdateAt(t)).toBe(later(2))
  })

  it('is empty when nothing has completed', () => {
    expect(latestUpdateAt({ items: [], rides: [] })).toBe('')
  })
})

describe('acceptHookAction', () => {
  const PATH = '.lander/hooks/ride-ended/any/supervise.js'
  const act = (over: Partial<Parameters<typeof acceptHookAction>[1]> = {}) => ({
    hook: PATH,
    fireId: 'fire-1',
    key: 'nudge#0',
    kind: 'nudge' as const,
    at: AT,
    ...over,
  })

  it('refuses the 4th action for one hook, and admits another hook’s 1st', () => {
    const t: { hookActions?: HookAction[]; hookActionsResetAt?: string } = {}
    for (let i = 0; i < HOOK_ACTION_BOUND; i++)
      expect(acceptHookAction(t, act({ fireId: `f${i}`, at: later(i) })).ok).toBe(true)
    expect(acceptHookAction(t, act({ fireId: 'f9', at: later(4) }))).toEqual({
      ok: false,
      reason: 'bound',
    })
    // The bound is per hook, so a different hook on the same target is unaffected.
    expect(
      acceptHookAction(t, act({ hook: '.lander/hooks/landed/any/cleanup.js', fireId: 'f9' })).ok,
    ).toBe(true)
  })

  // Both stamps are millisecond toISOString(), so an action in the same
  // millisecond as the reset is on the far side of it.
  it('counts only actions strictly after the reset', () => {
    const t: { hookActions?: HookAction[]; hookActionsResetAt?: string } = {
      hookActions: [
        { hook: PATH, fireId: 'a', key: 'k', kind: 'nudge', at: AT },
        { hook: PATH, fireId: 'b', key: 'k', kind: 'nudge', at: later(1) },
        { hook: PATH, fireId: 'c', key: 'k', kind: 'nudge', at: later(2) },
      ],
      hookActionsResetAt: later(1),
    }
    // Only the later(2) action counts, so there is room.
    expect(acceptHookAction(t, act({ fireId: 'd', at: later(3) })).ok).toBe(true)
  })

  it('counts every action when the target has never been touched', () => {
    const t: { hookActions?: HookAction[]; hookActionsResetAt?: string } = {
      hookActions: Array.from({ length: HOOK_ACTION_BOUND }, (_, i) => ({
        hook: PATH,
        fireId: `f${i}`,
        key: 'k',
        kind: 'nudge' as const,
        at: later(i),
      })),
    }
    expect(acceptHookAction(t, act({ fireId: 'f9' })).ok).toBe(false)
  })

  // The retry guarantee: a run that does not complete is re-dispatched, so the
  // same fire presents the same action again. It must no-op, and it must not
  // spend a bounded slot — a retry storm would otherwise exhaust the bound
  // without the hook ever acting twice.
  it('dedupes a repeat of the same (hook, fire, key) without spending the bound', () => {
    const t: { hookActions?: HookAction[]; hookActionsResetAt?: string } = {}
    const first = acceptHookAction(t, act())
    expect(first).toMatchObject({ ok: true })
    for (let i = 0; i < 10; i++) {
      const again = acceptHookAction(t, act({ at: later(1) }))
      expect(again).toMatchObject({ ok: true, deduped: true })
    }
    expect(t.hookActions).toHaveLength(1)
    // Still two slots left, despite eleven presentations.
    expect(acceptHookAction(t, act({ fireId: 'f2', key: 'nudge#0' })).ok).toBe(true)
    expect(acceptHookAction(t, act({ fireId: 'f3', key: 'nudge#0' })).ok).toBe(true)
    expect(acceptHookAction(t, act({ fireId: 'f4', key: 'nudge#0' })).ok).toBe(false)
  })

  // The case a payload hash would miss: the body composes different text on the
  // retry (a timestamp, a moved HEAD), but it is the same action of the same fire.
  it('dedupes even when the body would have composed a different payload', () => {
    const t: { hookActions?: HookAction[] } = {}
    acceptHookAction(t, act())
    expect(acceptHookAction(t, act({ kind: 'land' }))).toMatchObject({ deduped: true })
    expect(t.hookActions).toHaveLength(1)
  })

  it('lets two deliberately different actions in one fire both through', () => {
    const t: { hookActions?: HookAction[] } = {}
    expect(acceptHookAction(t, act({ key: 'nudge#0' })).ok).toBe(true)
    expect(acceptHookAction(t, act({ key: 'nudge#1' })).ok).toBe(true)
    expect(t.hookActions).toHaveLength(2)
  })

  it('keeps the most recent MAX_HOOK_ACTIONS entries', () => {
    const t: { hookActions?: HookAction[] } = {}
    for (let i = 0; i < MAX_HOOK_ACTIONS + 5; i++)
      acceptHookAction(t, {
        hook: `${PATH}${i}`, // a fresh hook each time, so the bound never bites
        fireId: `f${i}`,
        key: 'k',
        kind: 'nudge',
        at: AT,
      })
    expect(t.hookActions).toHaveLength(MAX_HOOK_ACTIONS)
    expect(t.hookActions!.at(-1)!.hook).toBe(`${PATH}${MAX_HOOK_ACTIONS + 4}`)
  })

  // A launch is recorded before the task it names is written, so the one caller
  // that can find out afterwards that its action did not happen has to be able
  // to take it back. Left in place, the record is answered "already launched"
  // to every retry, with an id that resolves to nothing.
  describe('dropHookAction', () => {
    const seeded = () => {
      const t: { hookActions?: HookAction[] } = {}
      acceptHookAction(t, act({ fireId: 'f1', key: 'launch#0', kind: 'launch' }))
      acceptHookAction(t, act({ fireId: 'f1', key: 'launch#1', kind: 'launch' }))
      return t
    }

    it('removes exactly the one action, and refunds its bounded slot', () => {
      const t = seeded()
      dropHookAction(t, { hook: PATH, fireId: 'f1', key: 'launch#0' })
      expect(t.hookActions).toMatchObject([{ key: 'launch#1' }])
      // The slot is free again: an action that created nothing is not an action
      // to bound, and the next launch takes the key rather than being deduped
      // against one that never happened.
      expect(acceptHookAction(t, act({ fireId: 'f1', key: 'launch#0' })).ok).toBe(true)
    })

    it('is a no-op for an action that was never recorded', () => {
      const t = seeded()
      dropHookAction(t, { hook: PATH, fireId: 'f1', key: 'launch#7' })
      dropHookAction(t, { hook: 'other', fireId: 'f1', key: 'launch#0' })
      dropHookAction({}, { hook: PATH, fireId: 'f1', key: 'launch#0' })
      expect(t.hookActions).toHaveLength(2)
    })
  })
})

describe('lastTurnPrompts', () => {
  it('returns the trailing run of user items before the last ride', () => {
    const t = {
      items: [
        userItem('old', AT),
        flowItem('reply', 'r1', later(1)),
        userItem('p1', later(2)),
        userItem('p2', later(3)),
        flowItem('r2', 'r2', later(4)),
      ],
    }
    expect(lastTurnPrompts(t)).toEqual(['p1', 'p2'])
  })

  // The retry path stashes this and re-sends it. A hook's nudge must neither be
  // returned (it would come back as the user's words) nor walked past (the turn
  // would re-run a human instruction the task already completed) — so a
  // nudge-driven turn that fails yields nothing, and applyRetryRecovery's
  // "try again" branch takes over.
  it('yields nothing for a nudge-only turn, rather than the previous human prompt', () => {
    const t = {
      items: [
        userItem('do the thing', AT),
        flowItem('did it', 'r1', later(1)),
        hookItem('From hook s:\n\nreally finished?', later(2)),
        flowItem('failed', 'r2', later(3)),
      ],
    }
    expect(lastTurnPrompts(t)).toEqual([])
  })

  // A batch can deliver a human message and a nudge together. The user's half is
  // re-sendable; the hook's is not.
  it('returns only the user half of a mixed batch', () => {
    const t = {
      items: [
        flowItem('older', 'r1'),
        userItem('p1', later(1)),
        hookItem('From hook s:\n\nalso this', later(2)),
        flowItem('failed', 'r2', later(3)),
      ],
    }
    expect(lastTurnPrompts(t)).toEqual(['p1'])
  })
})

describe('turnAttachments', () => {
  it('gathers attachments off the trailing `count` user items', () => {
    const att = [{ id: 'x', name: 'f', mime: 'image/png', size: 1 }]
    const t = {
      items: [
        userItem('p1', AT, { attachments: att }),
        userItem('p2', later(1)),
      ],
    }
    expect(turnAttachments(t, 2)).toEqual(att)
    expect(turnAttachments(t, 1)).toEqual([]) // only p2, which has none
  })

  // A nudge carries no files but does occupy a queue slot. Counting only user
  // items would walk past it and hand the hook's turn an older message's files.
  it('does not attribute an older message’s attachments to a hook turn', () => {
    const att = [{ id: 'x', name: 'f', mime: 'image/png', size: 1 }]
    const t = {
      items: [userItem('p1', AT, { attachments: att }), hookItem('nudge', later(1))],
    }
    expect(turnAttachments(t, 1)).toEqual([])
  })
})

describe('deliverQueuedBatch', () => {
  const ids = (t: { items?: Item[] }) => (t.items ?? []).map((i) => i.id)

  it('moves a mid-ride follow-up to the tail so it renders between the two rides', () => {
    // 'F' was enqueued while ride rA was still streaming, so it sits between rA's
    // items in array order — the bug. After delivery it belongs after rA, before rB.
    const t: { items: Item[]; rides: Ride[] } = {
      items: [
        flowItem('a1', 'rA'),
        userItem('F', later(1)),
        flowItem('a2', 'rA', later(2)),
      ],
      rides: [
        { id: 'rA', startedAt: AT, endedAt: later(3) },
        { id: 'rB', startedAt: later(4), endedAt: later(5) },
      ],
    }
    deliverQueuedBatch(t, 1, 'rB')
    expect(ids(t)).toEqual(['f-a1', 'f-a2', 'u-F']) // F relocated to the tail
    expect((t.items.find((i) => i.id === 'u-F') as MessageItem).deliveredIn).toBe('rB')

    pushFlowItem(t, 'rB', 'b1', later(4)) // rB streams its reply after the move
    const seq = buildTimeline(t, later(9)).items.map((e) =>
      e.kind === 'ride' ? `ride:${e.ride.id}` : e.kind === 'user' ? `user:${e.item.text}` : e.kind,
    )
    expect(seq).toEqual(['ride:rA', 'user:F', 'ride:rB']) // rideA → follow-up → rideB
  })

  it('scopes the move to the batch — migrated/historical user items stay put', () => {
    // A v1-migrated task: every historical user item lacks `deliveredIn`. Only the
    // fresh follow-up (the trailing batch) may move; history must not collapse down.
    const t: { items: Item[] } = {
      items: [
        userItem('h1'),
        flowItem('r1a', 'r1', later(1)),
        userItem('h2', later(2)),
        flowItem('r2a', 'r2', later(3)),
        userItem('F', later(4)),
      ],
    }
    deliverQueuedBatch(t, 1, 'r3')
    expect(ids(t)).toEqual(['u-h1', 'f-r1a', 'u-h2', 'f-r2a', 'u-F']) // unchanged order
    expect((t.items[0] as MessageItem).deliveredIn).toBeUndefined() // history untouched
    expect((t.items[2] as MessageItem).deliveredIn).toBeUndefined()
    expect((t.items[4] as MessageItem).deliveredIn).toBe('r3') // only the batch stamped
  })

  it('leaves an already-delivered re-queued prompt in place (retry resend)', () => {
    // 'doX' was delivered in rA, which errored; retry re-queues it. It already carries
    // `deliveredIn`, so it must not jump below its own error reply.
    const t: { items: Item[] } = {
      items: [
        userItem('doX', AT, { deliveredIn: 'rA' }),
        flowItem('err', 'rA', later(1)),
        { id: 'ev', at: later(2), kind: 'event', eventKind: 'wedged', title: 'T' },
      ],
    }
    deliverQueuedBatch(t, 1, 'rB')
    expect(ids(t)).toEqual(['u-doX', 'f-err', 'ev']) // doX stays above its error reply
  })

  // The regression this whole commit exists to prevent: the queue window is
  // prompt items, not user items. Derived from `role === 'user'` alone, delivery
  // stamps and relocates the preceding HUMAN message instead of the nudge —
  // a durable reordering of the conversation, on the first nudge a task receives.
  it('moves the hook’s nudge, not the human message above it', () => {
    const t: { items: Item[] } = {
      items: [
        userItem('do the thing', AT),
        flowItem('a1', 'rA', later(1)),
        hookItem('From hook s:\n\nreally finished?', later(2)),
      ],
    }
    deliverQueuedBatch(t, 1, 'rB')
    expect(ids(t)).toEqual(['u-do the thing', 'f-a1', 'h-From hook s:\n\nreally finished?'])
    const [human, , nudge] = t.items as MessageItem[]
    expect(nudge.deliveredIn).toBe('rB')
    expect(human.deliveredIn).toBeUndefined() // the human's message is untouched
  })

  it('moves a whole batch of fresh follow-ups, preserving their order', () => {
    const t: { items: Item[] } = {
      items: [flowItem('a1', 'rA'), userItem('F1', later(1)), userItem('F2', later(2)), flowItem('a2', 'rA', later(3))],
    }
    deliverQueuedBatch(t, 2, 'rB')
    expect(ids(t)).toEqual(['f-a1', 'f-a2', 'u-F1', 'u-F2'])
  })
})

describe('recordArtifactOnMessage', () => {
  const artifact = { name: 'out', id: 'b', mime: 'text/plain', size: 2, createdAt: AT, updatedAt: AT }

  it('attaches to the open ride’s last flow item', () => {
    const t = {
      items: [flowItem('a', 'r1'), flowItem('b', 'r1', later(1))],
      rides: [{ id: 'r1', startedAt: AT } as Ride],
    }
    recordArtifactOnMessage(t, artifact)
    expect((t.items[1] as MessageItem).artifacts).toEqual([artifact])
  })

  it('updates an existing ref for the same name in place', () => {
    const host = flowItem('a', 'r1')
    host.artifacts = [artifact]
    const t = { items: [host], rides: [{ id: 'r1', startedAt: AT } as Ride] }
    recordArtifactOnMessage(t, { ...artifact, size: 99 })
    expect(host.artifacts).toHaveLength(1)
    expect(host.artifacts![0].size).toBe(99)
  })

  it('falls back to the last flow item when no ride is open, and no-ops with none', () => {
    const t = { items: [flowItem('a', 'r1')], rides: [{ id: 'r1', startedAt: AT, endedAt: later(1), outcome: 'done' } as Ride] }
    recordArtifactOnMessage(t, artifact)
    expect((t.items[0] as MessageItem).artifacts).toEqual([artifact])
    const empty = { items: [] as Item[] }
    expect(() => recordArtifactOnMessage(empty, artifact)).not.toThrow()
  })
})

describe('recordStatusTransition', () => {
  const task = (status: string) => ({ status, title: 'My task', items: [] as Item[] })
  const kinds = (t: { items: Item[] }) =>
    eventItems(t).map((e) => e.eventKind)

  it('records entry into a notable status', () => {
    const t = task('riding')
    recordStatusTransition(t, 'wedged', AT, 'human')
    expect(eventItems(t)[0]).toMatchObject({ eventKind: 'wedged', title: 'My task', at: AT })
  })

  it('records the inverse when leaving a notable status', () => {
    const t = task('wedged')
    recordStatusTransition(t, 'riding', AT, 'human')
    expect(kinds(t)).toEqual(['unwedged'])
  })

  it('records nothing for a quiet-to-quiet move or no change', () => {
    const t = task('riding')
    recordStatusTransition(t, 'riding', AT, 'human')
    expect(kinds(t)).toEqual([])
  })

  it('records only the arrival between two notable statuses', () => {
    const t = task('wedged')
    recordStatusTransition(t, 'landed', AT, 'human')
    expect(kinds(t)).toEqual(['landed'])
  })

  // Landing is terminal, so a surviving wakeup can only resurrect a finished
  // task to report it has nothing to do — the observed spurious-resume failure,
  // every case of which fired on a task that had already landed. Disarmed on the
  // crossing so no land route (`lander land`, `lander land <id>`, the UI) can
  // forget, the same way none can forget the event.
  describe('disarming wakeups on the way into landed', () => {
    const armed = (status: string) => ({
      ...task(status),
      scheduledFor: '2026-08-07T15:00:00.000Z',
      waitingFor: ['sib-a', 'sib-b'],
    })

    it('drops both triggers when a riding task lands', () => {
      const t = armed('riding')
      recordStatusTransition(t, 'landed', AT, 'human')
      expect(t.scheduledFor).toBeUndefined()
      expect(t.waitingFor).toBeUndefined()
    })

    // Including the await, which an early revival deliberately preserves: there
    // the task comes back, here there is nothing left to come back to.
    it('drops them from a wedged task too', () => {
      const t = armed('wedged')
      recordStatusTransition(t, 'landed', AT, 'human')
      expect(t.scheduledFor).toBeUndefined()
      expect(t.waitingFor).toBeUndefined()
    })

    it.each(['riding', 'wedged'] as const)(
      'leaves them alone crossing to %s',
      (next) => {
        const t = armed(next === 'riding' ? 'wedged' : 'riding')
        recordStatusTransition(t, next, AT, 'human')
        expect(t.scheduledFor).toBe('2026-08-07T15:00:00.000Z')
        expect(t.waitingFor).toEqual(['sib-a', 'sib-b'])
      },
    )

    // Un-landing still works; it just has no stale trigger left to revive.
    it('leaves a landed task revivable, with nothing armed', () => {
      const t = armed('riding')
      recordStatusTransition(t, 'landed', AT, 'human')
      t.status = 'landed'
      recordStatusTransition(t, 'riding', AT, 'human')
      expect(kinds(t)).toEqual(['landed', 'unlanded'])
      expect(t.scheduledFor).toBeUndefined()
      expect(t.waitingFor).toBeUndefined()
    })
  })

  // The one-shot revival marker rides the same funnel as the events, so no
  // revival route can forget to stamp it. Consumed by the next start-run.
  describe('the revival marker', () => {
    const revivedTask = (status: string) => ({
      ...task(status),
      revived: undefined as RevivedMarker | undefined,
    })

    it.each(['wedged', 'landed'] as const)(
      'stamps the prior status crossing %s → riding',
      (prev) => {
        const t = revivedTask(prev)
        recordStatusTransition(t, 'riding', AT, 'human')
        expect(t.revived).toEqual({ from: prev })
      },
    )

    // The other half of the marker is stamped by the /messages endpoint, which
    // can run either side of this: merge, don't assign.
    it('keeps a cleared-timer half another path already stamped', () => {
      const t = { ...revivedTask('wedged'), revived: { restUntil: '3:00 PM' } }
      recordStatusTransition(t, 'riding', AT, 'human')
      expect(t.revived).toEqual({ restUntil: '3:00 PM', from: 'wedged' })
    })

    it('stamps nothing when the status does not actually change', () => {
      const t = revivedTask('riding')
      recordStatusTransition(t, 'riding', AT, 'human')
      expect(t.revived).toBeUndefined()
    })

    // Entering the wedge is not a revival — stamping here would tell the agent
    // it had been revived on the very turn it wedged.
    it('stamps nothing entering wedged', () => {
      const t = revivedTask('riding')
      recordStatusTransition(t, 'wedged', AT, 'human')
      expect(t.revived).toBeUndefined()
    })

    it('stamps nothing crossing wedged → landed', () => {
      const t = revivedTask('wedged')
      recordStatusTransition(t, 'landed', AT, 'human')
      expect(t.revived).toBeUndefined()
    })
  })

  // The crossing settles any open ask, so that no caller has to remember to. The
  // rule is stated once here and every path that moves a task inherits it.
  describe('settling open asks on the crossing', () => {
    const asking = (status: string) => {
      const t = task(status)
      createAsk(t, {
        id: 'ask-0',
        form: { type: 'choice', options: [{ id: 'a', label: 'Alpha' }] },
        blocking: 'task',
        at: AT,
      })
      return t
    }
    const askState = (t: { items: Item[] }) => askItems(t)[0].state

    it.each([
      ['wedged', 'riding'],
      ['wedged', 'landed'],
      ['landed', 'riding'],
      ['riding', 'landed'],
    ])('withdraws an open ask crossing %s → %s', (prev, next) => {
      const t = asking(prev)
      recordStatusTransition(t, next, AT, 'human')
      expect(askState(t)).toBe('withdrawn')
    })

    // The exception, and the reason for it: this is the crossing that raises an
    // ask, so settling one here would eat the ask being raised.
    it('keeps an open ask crossing into wedged', () => {
      const t = asking('riding')
      recordStatusTransition(t, 'wedged', AT, 'human')
      expect(askState(t)).toBe('open')
    })

    // riding↔resting isn't a crossing at all (both store as `riding`), which is
    // what lets an advisory `lander ask` rest with its question still up.
    it('keeps an open ask when the status does not actually change', () => {
      const t = asking('riding')
      recordStatusTransition(t, 'riding', AT, 'human')
      expect(askState(t)).toBe('open')
    })

    it('leaves an already-settled ask alone', () => {
      const t = asking('wedged')
      askItems(t)[0].state = 'answered'
      recordStatusTransition(t, 'riding', AT, 'human')
      expect(askState(t)).toBe('answered')
    })
  })
})

// The trigger funnel: what a transition records for task hooks. The invariant
// that matters most is negative — developing lander must not fire hooks — so
// several of these assert that nothing was recorded.
describe('the task-hook trigger funnel', () => {
  const task = (status: string) => ({
    status,
    title: 'My task',
    items: [] as Item[],
    pendingHooks: undefined as PendingHook[] | undefined,
    hookFireSeq: undefined as number | undefined,
  })
  const fires = (t: { pendingHooks?: PendingHook[] }) =>
    (t.pendingHooks ?? []).map((f) => `${f.trigger}/${f.by}`)

  describe('status crossings', () => {
    it.each([
      ['riding', 'wedged', 'wedged'],
      ['riding', 'landed', 'landed'],
      ['wedged', 'riding', 'unwedged'],
      ['landed', 'riding', 'unlanded'],
      ['wedged', 'landed', 'landed'],
    ])('records one fire crossing %s → %s', (prev, next, trigger) => {
      const t = task(prev)
      recordStatusTransition(t, next, AT, 'human')
      expect(fires(t)).toEqual([`${trigger}/human`])
      expect(t.pendingHooks![0]).toMatchObject({ at: AT })
    })

    // riding↔resting is not a crossing at all (both store as `riding`), and it
    // is by far the most common move a task makes. Firing here would mean a hook
    // per turn boundary on top of the ride-ended one.
    it('records nothing when the status does not actually change', () => {
      const t = task('riding')
      recordStatusTransition(t, 'riding', AT, 'human')
      expect(fires(t)).toEqual([])
    })

    // `by` is half the selection axis: a hook under `landed/agent/` must not see
    // a human's landing, and vice versa. Carried verbatim rather than mapped, so
    // a new principal needs no change here.
    it.each(['human', 'agent', 'task', 'system'])('carries by=%s', (by) => {
      const t = task('riding')
      recordStatusTransition(t, 'landed', AT, by)
      expect(t.pendingHooks![0].by).toBe(by)
    })

    it('gives each fire a distinct, persisted id', () => {
      const t = task('riding')
      recordStatusTransition(t, 'wedged', AT, 'human')
      t.status = 'wedged'
      recordStatusTransition(t, 'riding', AT, 'human')
      const ids = t.pendingHooks!.map((f) => f.id)
      expect(new Set(ids).size).toBe(2)
      expect(t.hookFireSeq).toBe(2)
    })

    // Oldest first, because the dispatcher has not landed yet and a daemon
    // outage holds entries rather than dropping them.
    it('caps the backlog', () => {
      const t = task('riding')
      for (let i = 0; i < MAX_PENDING_HOOKS + 5; i++) {
        t.status = i % 2 === 0 ? 'riding' : 'wedged'
        recordStatusTransition(t, i % 2 === 0 ? 'wedged' : 'riding', AT, 'human')
      }
      expect(t.pendingHooks).toHaveLength(MAX_PENDING_HOOKS)
      // The counter keeps climbing, so a dropped fire's id can never recur.
      expect(t.hookFireSeq).toBe(MAX_PENDING_HOOKS + 5)
    })
  })

  describe('ride-ended', () => {
    const ride = { id: 'ride-1', startedAt: AT }

    it.each([
      ['done', 'agent'],
      ['error', 'system'],
    ] as const)('records a %s ride as by=%s', (outcome, by) => {
      const t = task('riding')
      recordRideEnded(t, ride, outcome, AT)
      expect(fires(t)).toEqual([`ride-ended/${by}`])
      expect(t.pendingHooks![0]).toMatchObject({ rideId: 'ride-1', outcome })
    })

    // A human or a sibling interrupting a riding task has already recorded its
    // own status crossing with the right principal. Firing supervision here is
    // the "nudge it back to work and undo the interrupt" failure, so it is
    // excluded structurally rather than left for every body to filter.
    it('records nothing for an interrupted ride', () => {
      const t = task('riding')
      recordRideEnded(t, ride, 'interrupted', AT)
      expect(fires(t)).toEqual([])
    })

    // The mechanical-failure case the trigger exists for must survive that
    // exclusion: an idle-timeout kill settles interrupted:false / exitCode 1, so
    // it arrives as `error`, not as an interrupt.
    it('still records the idle-kill shape', () => {
      const t = task('riding')
      recordRideEnded(t, ride, 'error', AT)
      expect(fires(t)).toEqual(['ride-ended/system'])
    })

    // closeRide no-ops with no open ride, so an unguarded record would emit a
    // fire naming a ride that some other path closed for another reason.
    it('records nothing when no ride was open', () => {
      const t = task('riding')
      recordRideEnded(t, undefined, 'done', AT)
      expect(fires(t)).toEqual([])
    })
  })

  // The first invariant of the whole feature: developing lander in the instance
  // doing the developing must not fire hooks. `closeRide` has five callers, two
  // of which (recoverQueues, driveTask's finally) run on a boot or a drain and
  // close rides as `interrupted`. Sourcing from closeRide itself would turn every
  // `server/**` edit into a burst of fires.
  it('records nothing when closeRide is called directly', () => {
    const t = { ...task('riding'), rides: [{ id: 'ride-1', startedAt: AT }] }
    closeRide(t, 'interrupted', AT)
    closeRide(t, 'done', AT)
    expect(fires(t)).toEqual([])
  })

  // The third close site: this branch does not merely close a ride, it opens and
  // closes a complete one, from runTurn's pre-startRide failures — which are the
  // "wedged for mechanical reasons" case supervision exists for.
  it('records exactly one fire for a synthesized error ride', () => {
    const t = { ...task('riding'), rides: [] as Ride[] }
    recordAssistantError(t, 'no daemon connected for this project', AT)
    expect(fires(t)).toEqual(['ride-ended/system'])
    expect(t.pendingHooks![0].rideId).toBe(t.rides[0].id)
  })

  // Its other branch fills an open ride and closes nothing, so applyDone or the
  // platform-kill branch will record that ride's end — not this.
  it('records nothing when it fills a ride that is already open', () => {
    const t = { ...task('riding'), rides: [{ id: 'ride-1', startedAt: AT }] }
    recordAssistantError(t, 'error running assistant: exited 1', AT)
    expect(fires(t)).toEqual([])
  })
})

describe('thread-state accessors', () => {
  it('writes session and turn context into flowState', () => {
    const t: { flowState?: Record<string, unknown>; sessionId?: string } = {}
    setTaskSessionId(t, 'sess-new')
    setTaskTurnContext(t, '<task-context>…</task-context>')
    expect(t.flowState).toEqual({
      sessionId: 'sess-new',
      turnContext: '<task-context>…</task-context>',
    })
    // Nothing lands at the old location any more.
    expect('sessionId' in t).toBe(false)
  })

  it('still reads a pre-flip task stored at the top level', () => {
    // The fallback is permanent, not transitional: nothing migrates a legacy
    // task (reduceRunWs's set-once guard means an adapter turn never rewrites an
    // id it already has), so dropping the union would silently strand those
    // conversations and mint fresh sessions for them.
    const t = { sessionId: 'sess-legacy', turnContext: 'ctx-legacy' }
    expect(taskSessionId(t)).toBe('sess-legacy')
    expect(taskTurnContext(t)).toBe('ctx-legacy')
  })

  it('prefers flowState over a stale top-level value', () => {
    const t = {
      sessionId: 'sess-legacy',
      flowState: { sessionId: 'sess-new' },
    }
    expect(taskSessionId(t)).toBe('sess-new')
  })

  it('converts a legacy task on its next write', () => {
    const t: {
      sessionId?: string
      flowState?: Record<string, unknown>
    } = { sessionId: 'sess-legacy' }
    setTaskSessionId(t, 'sess-fresh')
    expect(taskSessionId(t)).toBe('sess-fresh')
    expect(t.flowState).toEqual({ sessionId: 'sess-fresh' })
  })

  it('clears both locations, so the union cannot resurrect a sealed session', () => {
    const t = {
      sessionId: 'sess-legacy',
      turnContext: 'ctx-legacy',
      flowState: { sessionId: 'sess-new', turnContext: 'ctx-new', phase: 'x' },
    }
    clearTaskThread(t)
    expect(taskSessionId(t)).toBeUndefined()
    expect(taskTurnContext(t)).toBeUndefined()
    // Only thread identity goes; the rest of the flow's state is untouched.
    expect(t.flowState).toEqual({ phase: 'x' })
  })
})

describe('applyRelaunch', () => {
  const AT2 = '2026-06-01T00:00:00.000Z'
  type RelaunchTask = {
    sessionId?: string
    turnContext?: string
    status: string
    title: string
    updatedAt?: string
    items?: Item[]
    queued?: string[]
    scheduledMessages?: ScheduledMessage[]
    retry?: unknown
  }
  const task = (over: Partial<RelaunchTask> = {}): RelaunchTask => ({
    sessionId: 'sess-old',
    status: 'riding',
    title: 'My task',
    updatedAt: '2026-05-01T00:00:00.000Z',
    items: [userItem('q'), flowItem('reply', 'r0')],
    ...over,
  })

  it('seals the session, records the divider event item, and queues the message', () => {
    const t = task()
    applyRelaunch(t, 'go again', AT2, 'human')
    expect('sessionId' in t).toBe(false)
    expect(eventItems(t).some((e) => e.eventKind === 'relaunched')).toBe(true)
    expect(userItems(t).at(-1)?.text).toBe('go again')
    expect(t.queued).toEqual(['go again'])
    expect(t.status).toBe('riding')
  })

  it('revives a wedged task, recording the un-wedge ahead of the divider', () => {
    const t = task({ status: 'wedged' })
    applyRelaunch(t, 'go', AT2, 'human')
    expect(eventItems(t).map((e) => e.eventKind)).toEqual(['unwedged', 'relaunched'])
  })

  it('supersedes any pending retry', () => {
    const t = task({ retry: { committed: false, prompts: ['x'] } })
    applyRelaunch(t, 'go', AT2, 'human')
    expect('retry' in t).toBe(false)
  })
})

describe('applyDueMessages', () => {
  const AT2 = '2026-06-01T00:00:00.000Z'
  const task = () => ({ title: 'T', items: [] as Item[], queued: [] as string[] })

  it('appends and queues each due message as a user item', () => {
    const t = task()
    applyDueMessages(t, [{ text: 'a' }, { text: 'b' }], AT2)
    expect(userItems(t).map((u) => u.text)).toEqual(['a', 'b'])
    expect(t.queued).toEqual(['a', 'b'])
  })

  it('seals once and leads with the relaunch text when a relaunch is due', () => {
    const t = task()
    applyDueMessages(t, [{ text: 'ordinary' }, { text: 'fresh', relaunch: true }], AT2)
    expect(eventItems(t).filter((e) => e.eventKind === 'relaunched')).toHaveLength(1)
    expect(t.queued).toEqual(['fresh', 'ordinary'])
  })
})

describe('armScheduledRelaunch', () => {
  it('records a pending relaunched event item carrying the launch time', () => {
    const t = { title: 'T', items: [] as Item[], scheduledMessages: [] as ScheduledMessage[] }
    armScheduledRelaunch(t, { text: 'later', deliverAt: '2027-01-01T00:00:00.000Z' }, AT)
    expect(t.scheduledMessages[0]).toMatchObject({ text: 'later', relaunch: true })
    expect(eventItems(t)[0]).toMatchObject({ eventKind: 'relaunched', scheduledFor: '2027-01-01T00:00:00.000Z' })
  })
})

describe('nextRepeatMessage', () => {
  const AT2 = '2026-01-01T12:00:00.000Z'
  it('returns null without a repeat spec', () => {
    expect(nextRepeatMessage({ text: 'x' }, AT2)).toBeNull()
  })
  it('advances by the interval and decrements remaining', () => {
    const next = nextRepeatMessage({ text: 'x', repeat: { interval: 60, remaining: 2 } }, AT2)
    expect(next).toMatchObject({ text: 'x', relaunch: true, deliverAt: '2026-01-01T13:00:00.000Z' })
    expect(next?.repeat).toEqual({ interval: 60, remaining: 1 })
  })
  it('stops at the count bound and the until cutoff', () => {
    expect(nextRepeatMessage({ text: 'x', repeat: { interval: 60, remaining: 0 } }, AT2)).toBeNull()
    expect(nextRepeatMessage({ text: 'x', repeat: { interval: 60, until: '2026-01-01T12:30:00.000Z' } }, AT2)).toBeNull()
  })
})

describe('rides', () => {
  const END = later(5)
  it('startRide opens, openRide finds the last un-ended, closeRide stamps it', () => {
    const t: { rides?: Ride[] } = {}
    startRide(t, 'r1', AT)
    expect(openRide(t)).toMatchObject({ id: 'r1', startedAt: AT })
    const usage = { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 }
    closeRide(t, 'done', END, usage)
    expect(t.rides![0]).toEqual({ id: 'r1', startedAt: AT, endedAt: END, outcome: 'done', usage })
    expect(openRide(t)).toBeUndefined()
  })

  it('closeRide no-ops when no ride is open', () => {
    expect(() => closeRide({}, 'interrupted', END)).not.toThrow()
  })
})

describe('worktreeName', () => {
  const project = '/home/me/proj'
  it('returns a worktree name directly under the worktrees dir', () => {
    expect(worktreeName(project, '/home/me/proj/.claude/worktrees/feat-x')).toBe('feat-x')
  })
  it('keeps a slash-segmented worktree name whole', () => {
    expect(worktreeName(project, '/home/me/proj/.claude/worktrees/feature/x')).toBe('feature/x')
  })
  it('rejects a path outside this project and the worktrees dir itself', () => {
    expect(worktreeName(project, '/somewhere/else/.claude/worktrees/x')).toBe(undefined)
    expect(worktreeName(project, '/home/me/proj/.claude/worktrees')).toBe(undefined)
  })
})
