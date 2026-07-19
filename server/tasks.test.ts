import { describe, it, expect } from 'vitest'
import {
  publicTask,
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
  type Item,
  type MessageItem,
  type ScheduledMessage,
  type Ride,
} from './tasks'
import { askItems, createAsk } from './asks'
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
    recordStatusTransition(t, 'wedged', AT)
    expect(eventItems(t)[0]).toMatchObject({ eventKind: 'wedged', title: 'My task', at: AT })
  })

  it('records the inverse when leaving a notable status', () => {
    const t = task('wedged')
    recordStatusTransition(t, 'riding', AT)
    expect(kinds(t)).toEqual(['unwedged'])
  })

  it('records nothing for a quiet-to-quiet move or no change', () => {
    const t = task('riding')
    recordStatusTransition(t, 'riding', AT)
    expect(kinds(t)).toEqual([])
  })

  it('records only the arrival between two notable statuses', () => {
    const t = task('wedged')
    recordStatusTransition(t, 'landed', AT)
    expect(kinds(t)).toEqual(['landed'])
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
      recordStatusTransition(t, next, AT)
      expect(askState(t)).toBe('withdrawn')
    })

    // The exception, and the reason for it: this is the crossing that raises an
    // ask, so settling one here would eat the ask being raised.
    it('keeps an open ask crossing into wedged', () => {
      const t = asking('riding')
      recordStatusTransition(t, 'wedged', AT)
      expect(askState(t)).toBe('open')
    })

    // riding↔resting isn't a crossing at all (both store as `riding`), which is
    // what lets an advisory `lander ask` rest with its question still up.
    it('keeps an open ask when the status does not actually change', () => {
      const t = asking('riding')
      recordStatusTransition(t, 'riding', AT)
      expect(askState(t)).toBe('open')
    })

    it('leaves an already-settled ask alone', () => {
      const t = asking('wedged')
      askItems(t)[0].state = 'answered'
      recordStatusTransition(t, 'riding', AT)
      expect(askState(t)).toBe('answered')
    })
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
    applyRelaunch(t, 'go again', AT2)
    expect('sessionId' in t).toBe(false)
    expect(eventItems(t).some((e) => e.eventKind === 'relaunched')).toBe(true)
    expect(userItems(t).at(-1)?.text).toBe('go again')
    expect(t.queued).toEqual(['go again'])
    expect(t.status).toBe('riding')
  })

  it('revives a wedged task, recording the un-wedge ahead of the divider', () => {
    const t = task({ status: 'wedged' })
    applyRelaunch(t, 'go', AT2)
    expect(eventItems(t).map((e) => e.eventKind)).toEqual(['unwedged', 'relaunched'])
  })

  it('supersedes any pending retry', () => {
    const t = task({ retry: { committed: false, prompts: ['x'] } })
    applyRelaunch(t, 'go', AT2)
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
