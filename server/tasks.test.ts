import { describe, it, expect } from 'vitest'
import {
  publicTask,
  latestUpdateAt,
  recordStatusTransition,
  pendingMessage,
  ensurePending,
  lastTurnPrompts,
  worktreeName,
  applyRelaunch,
  applyDueMessages,
  armScheduledRelaunch,
  nextRepeatMessage,
  type Message,
  type TaskEvent,
  type ScheduledMessage,
} from './tasks'

const msg = (over: Partial<Message>): Message => ({
  role: 'assistant',
  text: '',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('publicTask', () => {
  it('strips token, runId and runCursor, preserving everything else', () => {
    const out = publicTask({
      id: 's',
      title: 't',
      token: 'secret',
      runId: 'r1',
      runCursor: 42,
      allowEdits: true,
    })
    expect(out).toEqual({ id: 's', title: 't', allowEdits: true })
    expect('token' in out).toBe(false)
    expect('runId' in out).toBe(false)
    expect('runCursor' in out).toBe(false)
  })

  it('does not choke when the stripped fields are absent', () => {
    expect(publicTask({ id: 's' })).toEqual({ id: 's' })
  })

  it('returns a shallow copy (nested arrays are shared, not cloned)', () => {
    const messages = [msg({ text: 'hi' })]
    const task = { id: 's', messages, token: 'x' }
    const out = publicTask(task)
    expect((out as { messages: Message[] }).messages).toBe(messages)
  })

  it('projects the work queue onto the trailing user messages and drops the queue', () => {
    const messages = [
      msg({ role: 'user', text: 'p1' }),
      msg({ role: 'assistant', text: 'r1' }),
      msg({ role: 'user', text: 'p2' }),
      msg({ role: 'user', text: 'p3' }),
    ]
    const out = publicTask({ id: 's', messages, queued: ['p2', 'p3'] })
    const m = (out as { messages: Message[] }).messages
    expect(m.map((x) => !!x.queued)).toEqual([false, false, true, true])
    // The raw queue is not exposed.
    expect('queued' in out).toBe(false)
    // The source messages are untouched (projection clones only the flagged).
    expect(messages.some((x) => x.queued)).toBe(false)
  })

  it('leaves messages untouched when nothing is queued', () => {
    const messages = [msg({ role: 'user', text: 'p1' })]
    const out = publicTask({ id: 's', messages })
    expect((out as { messages: Message[] }).messages).toBe(messages)
  })
})

describe('latestUpdateAt', () => {
  it('returns the newest timestamp across completed messages and events', () => {
    expect(
      latestUpdateAt({
        messages: [
          msg({ createdAt: '2026-01-01T00:00:00.000Z' }),
          msg({ createdAt: '2026-03-01T00:00:00.000Z' }),
        ],
        events: [{ kind: 'landed', createdAt: '2026-02-01T00:00:00.000Z' }],
      }),
    ).toBe('2026-03-01T00:00:00.000Z')
  })

  it('lets a later event win over the messages', () => {
    expect(
      latestUpdateAt({
        messages: [msg({ createdAt: '2026-01-01T00:00:00.000Z' })],
        events: [{ kind: 'wedged', createdAt: '2026-05-01T00:00:00.000Z' }],
      }),
    ).toBe('2026-05-01T00:00:00.000Z')
  })

  it('skips the in-flight (pending) message', () => {
    expect(
      latestUpdateAt({
        messages: [
          msg({ createdAt: '2026-01-01T00:00:00.000Z' }),
          msg({ createdAt: '2026-09-01T00:00:00.000Z', pending: true }),
        ],
      }),
    ).toBe('2026-01-01T00:00:00.000Z')
  })

  it('tolerates absent events', () => {
    expect(latestUpdateAt({ messages: [msg({ createdAt: '2026-01-01T00:00:00.000Z' })] })).toBe(
      '2026-01-01T00:00:00.000Z',
    )
  })

  it('returns empty string when nothing has completed', () => {
    expect(latestUpdateAt({ messages: [] })).toBe('')
    expect(
      latestUpdateAt({ messages: [msg({ createdAt: '2026-01-01T00:00:00.000Z', pending: true })] }),
    ).toBe('')
  })
})

describe('pendingMessage', () => {
  it('returns the last pending assistant message', () => {
    const target = msg({ text: 'live', pending: true })
    const task = {
      messages: [
        msg({ role: 'user', text: 'q' }),
        msg({ text: 'done' }),
        target,
      ],
    }
    expect(pendingMessage(task)).toBe(target)
  })

  it('returns undefined when no message is pending', () => {
    expect(
      pendingMessage({ messages: [msg({ role: 'user' }), msg({ text: 'done' })] }),
    ).toBeUndefined()
  })

  it('ignores a pending user message', () => {
    expect(
      pendingMessage({ messages: [msg({ role: 'user', pending: true })] }),
    ).toBeUndefined()
  })
})

describe('lastTurnPrompts', () => {
  it('returns the trailing user messages before the final reply', () => {
    expect(
      lastTurnPrompts([
        msg({ role: 'user', text: 'first' }),
        msg({ text: 'reply 1' }),
        msg({ role: 'user', text: 'a' }),
        msg({ role: 'user', text: 'b' }),
        msg({ text: 'error running claude: exited 1' }),
      ]),
    ).toEqual(['a', 'b'])
  })

  it('skips multiple trailing assistant messages', () => {
    expect(
      lastTurnPrompts([
        msg({ role: 'user', text: 'q' }),
        msg({ text: 'partial' }),
        msg({ text: 'error' }),
      ]),
    ).toEqual(['q'])
  })

  it('returns empty when the turn has no user prompt', () => {
    expect(lastTurnPrompts([msg({ text: 'reply' })])).toEqual([])
  })
})

describe('ensurePending', () => {
  it('returns the existing pending message without creating a duplicate', () => {
    const existing = msg({ text: 'live', pending: true })
    const task = { messages: [existing] }
    expect(ensurePending(task)).toBe(existing)
    expect(task.messages).toHaveLength(1)
  })

  it('creates, pushes, and returns a fresh pending assistant message', () => {
    const task: { messages: Message[] } = { messages: [msg({ role: 'user', text: 'q' })] }
    const created = ensurePending(task)
    expect(created).toMatchObject({ role: 'assistant', text: '', steps: [], pending: true })
    expect(task.messages).toHaveLength(2)
    expect(task.messages[1]).toBe(created)
  })
})

describe('recordStatusTransition', () => {
  const task = (status: string, events?: TaskEvent[]) => ({
    status,
    title: 'My task',
    events,
  })
  const AT = '2026-06-01T00:00:00.000Z'

  it('is a no-op when the status does not change', () => {
    const t = task('resting', [])
    recordStatusTransition(t, 'resting', AT)
    expect(t.events).toEqual([])
  })

  it('records entry into a notable status', () => {
    const t = task('riding')
    recordStatusTransition(t, 'wedged', AT)
    expect(t.events).toEqual([{ kind: 'wedged', title: 'My task', createdAt: AT }])

    const t2 = task('riding')
    recordStatusTransition(t2, 'landed', AT)
    expect(t2.events).toEqual([{ kind: 'landed', title: 'My task', createdAt: AT }])
  })

  it('records the inverse when leaving a notable status for a quiet one', () => {
    const t = task('wedged')
    recordStatusTransition(t, 'resting', AT)
    expect(t.events).toEqual([{ kind: 'unwedged', title: 'My task', createdAt: AT }])

    const t2 = task('landed')
    recordStatusTransition(t2, 'riding', AT)
    expect(t2.events).toEqual([{ kind: 'unlanded', title: 'My task', createdAt: AT }])
  })

  it('records no event for a quiet-to-quiet move', () => {
    const t = task('riding')
    recordStatusTransition(t, 'resting', AT)
    expect(t.events ?? []).toEqual([])
  })

  it('records only the arrival when moving between two notable statuses', () => {
    const t = task('wedged')
    recordStatusTransition(t, 'landed', AT)
    // No 'unwedged' — just the 'landed' arrival.
    expect(t.events).toEqual([{ kind: 'landed', title: 'My task', createdAt: AT }])
  })

  it('initializes the events array when absent and reads the old status', () => {
    const t = task('wedged') // events undefined
    recordStatusTransition(t, 'resting', AT)
    expect(t.events).toEqual([{ kind: 'unwedged', title: 'My task', createdAt: AT }])
  })
})

describe('applyRelaunch', () => {
  const AT = '2026-06-01T00:00:00.000Z'
  type RelaunchTask = {
    sessionId?: string
    status: string
    title: string
    updatedAt?: string
    events?: TaskEvent[]
    messages: Message[]
    queued?: string[]
    scheduledMessages?: ScheduledMessage[]
    retry?: unknown
  }
  const task = (over: Partial<RelaunchTask> = {}): RelaunchTask => ({
    sessionId: 'sess-old',
    status: 'riding',
    title: 'My task',
    updatedAt: '2026-05-01T00:00:00.000Z',
    messages: [msg({ role: 'user', text: 'q' }), msg({ text: 'reply' })],
    ...over,
  })

  it('seals the session, appends the relaunched divider, and queues the message', () => {
    const t = task()
    applyRelaunch(t, 'go again', AT)
    // The old session is gone — the next turn hands the daemon no sessionId, so it
    // mints a fresh one (the whole point of relaunch).
    expect('sessionId' in t).toBe(false)
    // The divider event marks where the new session begins.
    expect(t.events).toContainEqual({
      kind: 'relaunched',
      title: 'My task',
      createdAt: AT,
    })
    // The message is appended and queued for the fresh session; status rides.
    expect(t.messages.at(-1)).toMatchObject({ role: 'user', text: 'go again' })
    expect(t.queued).toEqual(['go again'])
    expect(t.status).toBe('riding')
    expect(t.updatedAt).toBe(AT)
  })

  it('a relaunch with no session yet just opens a fresh one (harmless)', () => {
    const t = task({ sessionId: undefined })
    applyRelaunch(t, 'go', AT)
    expect('sessionId' in t).toBe(false)
    expect(t.queued).toEqual(['go'])
  })

  it('revives a wedged task, recording the un-wedge ahead of the divider', () => {
    const t = task({ status: 'wedged' })
    applyRelaunch(t, 'go', AT)
    const kinds = (t.events ?? []).map((e) => e.kind)
    // The un-wedge is recorded a hair before the relaunch divider.
    expect(kinds).toEqual(['unwedged', 'relaunched'])
    const unwedged = t.events!.find((e) => e.kind === 'unwedged')!
    expect(unwedged.createdAt < AT).toBe(true)
    expect(t.status).toBe('riding')
  })

  it('supersedes any pending retry', () => {
    const t = task({ retry: { committed: false, prompts: ['x'] } })
    applyRelaunch(t, 'go', AT)
    expect('retry' in t).toBe(false)
  })

  it('does not arm a successor for a one-shot (no repeat) relaunch', () => {
    const t = task()
    applyRelaunch(t, 'go', AT)
    expect('scheduledMessages' in t).toBe(false)
  })

  it('arms the next occurrence off this delivery for a repeating relaunch', () => {
    const t = task()
    // remaining=2 → this immediate is #1 of a 3-relaunch series; the armed
    // successor carries remaining=1 (two more, #2 and #3, follow it).
    applyRelaunch(t, 'go', AT, { interval: 60, remaining: 2 })
    expect(t.queued).toEqual(['go'])
    expect(t.scheduledMessages).toEqual([
      {
        text: 'go',
        deliverAt: '2026-06-01T01:00:00.000Z',
        relaunch: true,
        repeat: { interval: 60, remaining: 1 },
      },
    ])
  })

  it('arms no successor when the immediate relaunch exhausts the count', () => {
    const t = task()
    // remaining=0 → a 1-relaunch series; nothing follows the immediate one.
    applyRelaunch(t, 'go', AT, { interval: 60, remaining: 0 })
    expect('scheduledMessages' in t).toBe(false)
  })

  it('arms no successor when the interval would overshoot repeat-until', () => {
    const t = task()
    applyRelaunch(t, 'go', AT, { interval: 60, until: '2026-06-01T00:30:00.000Z' })
    expect('scheduledMessages' in t).toBe(false)
  })
})

describe('nextRepeatMessage', () => {
  const AT = '2026-06-01T00:00:00.000Z'

  it('returns null when the entry carries no repeat spec', () => {
    expect(nextRepeatMessage({ text: 'x' }, AT)).toBeNull()
  })

  it('arms interval minutes after the actual delivery (no drift compensation)', () => {
    const next = nextRepeatMessage(
      { text: 'x', repeat: { interval: 60 } },
      '2026-06-01T02:01:00.000Z',
    )
    // Off 2:01, not off a nominal 2:00 — the series drifts by design.
    expect(next).toEqual({
      text: 'x',
      deliverAt: '2026-06-01T03:01:00.000Z',
      relaunch: true,
      repeat: { interval: 60 },
    })
  })

  it('decrements remaining and preserves an until bound', () => {
    const next = nextRepeatMessage(
      { text: 'x', repeat: { interval: 30, remaining: 3, until: '2026-06-02T00:00:00.000Z' } },
      AT,
    )
    expect(next).toMatchObject({
      deliverAt: '2026-06-01T00:30:00.000Z',
      repeat: { interval: 30, remaining: 2, until: '2026-06-02T00:00:00.000Z' },
    })
  })

  it('stops (null) once no relaunches remain', () => {
    expect(
      nextRepeatMessage({ text: 'x', repeat: { interval: 60, remaining: 0 } }, AT),
    ).toBeNull()
  })

  it('stops (null) once the next fire would pass the until cutoff', () => {
    // at + 60m = 01:00, which is after the 00:45 cutoff → done.
    expect(
      nextRepeatMessage(
        { text: 'x', repeat: { interval: 60, until: '2026-06-01T00:45:00.000Z' } },
        AT,
      ),
    ).toBeNull()
  })

  it('arms when the next fire lands exactly on the until cutoff (inclusive)', () => {
    const next = nextRepeatMessage(
      { text: 'x', repeat: { interval: 60, until: '2026-06-01T01:00:00.000Z' } },
      AT,
    )
    expect(next).toMatchObject({ deliverAt: '2026-06-01T01:00:00.000Z' })
  })

  it('drives a whole bounded series to completion', () => {
    // Total 3 relaunches: the first rides remaining=2, then re-arm until dry.
    let entry: ScheduledMessage | null = {
      text: 'x',
      repeat: { interval: 60, remaining: 2 },
    }
    const fires: string[] = []
    let at = AT
    while (entry) {
      fires.push(at)
      const nextEntry: ScheduledMessage | null = nextRepeatMessage(entry, at)
      if (nextEntry?.deliverAt) at = nextEntry.deliverAt
      entry = nextEntry
    }
    expect(fires).toEqual([
      '2026-06-01T00:00:00.000Z',
      '2026-06-01T01:00:00.000Z',
      '2026-06-01T02:00:00.000Z',
    ])
  })
})

describe('armScheduledRelaunch', () => {
  const AT = '2026-06-01T00:00:00.000Z'
  const WHEN = '2026-06-02T00:00:00.000Z'

  it('stashes a relaunch-flagged scheduled message without clearing the session', () => {
    const t = {
      sessionId: 'sess-old',
      title: 'My task',
      messages: [] as Message[],
    }
    armScheduledRelaunch(t, { text: 'later', deliverAt: WHEN }, AT)
    // The session stays live until the trigger fires — pre-trigger messages still
    // resume it.
    expect(t.sessionId).toBe('sess-old')
    expect((t as { scheduledMessages?: unknown[] }).scheduledMessages).toEqual([
      { text: 'later', deliverAt: WHEN, relaunch: true },
    ])
    // The armed event carries the launch time as the pending indicator.
    expect((t as { events?: TaskEvent[] }).events).toContainEqual({
      kind: 'relaunched',
      title: 'My task',
      createdAt: AT,
      scheduledFor: WHEN,
    })
  })

  it('omits scheduledFor on a pure await trigger', () => {
    const t = { title: 'My task' } as {
      title: string
      events?: TaskEvent[]
      scheduledMessages?: { text: string; waitFor?: string[]; relaunch?: boolean }[]
    }
    armScheduledRelaunch(t, { text: 'later', waitFor: ['abc'] }, AT)
    expect(t.scheduledMessages).toEqual([
      { text: 'later', waitFor: ['abc'], relaunch: true },
    ])
    expect(t.events).toEqual([
      { kind: 'relaunched', title: 'My task', createdAt: AT },
    ])
  })

  it('carries a repeat spec onto the armed message for a repeating relaunch', () => {
    const t = { title: 'My task' } as {
      title: string
      events?: TaskEvent[]
      scheduledMessages?: ScheduledMessage[]
    }
    armScheduledRelaunch(
      t,
      { text: 'later', deliverAt: WHEN, repeat: { interval: 60, remaining: 2 } },
      AT,
    )
    expect(t.scheduledMessages).toEqual([
      {
        text: 'later',
        deliverAt: WHEN,
        relaunch: true,
        repeat: { interval: 60, remaining: 2 },
      },
    ])
  })
})

describe('applyDueMessages', () => {
  const AT = '2026-06-01T00:00:00.000Z'

  it('appends and queues ordinary due messages without touching the session', () => {
    const t = {
      sessionId: 'sess-old',
      title: 'My task',
      messages: [] as Message[],
    }
    applyDueMessages(t, [{ text: 'a' }, { text: 'b' }], AT)
    expect(t.sessionId).toBe('sess-old')
    expect((t as { events?: TaskEvent[] }).events).toBeUndefined()
    expect(t.messages.map((m) => m.text)).toEqual(['a', 'b'])
    expect((t as { queued?: string[] }).queued).toEqual(['a', 'b'])
  })

  it('seals the session and pushes the divider when a due entry is a relaunch', () => {
    const t = {
      sessionId: 'sess-old',
      title: 'My task',
      messages: [] as Message[],
    }
    applyDueMessages(t, [{ text: 'fresh', relaunch: true }], AT)
    expect('sessionId' in t).toBe(false)
    expect((t as { events?: TaskEvent[] }).events).toEqual([
      { kind: 'relaunched', title: 'My task', createdAt: AT },
    ])
    expect((t as { queued?: string[] }).queued).toEqual(['fresh'])
  })

  it('seals once and orders the relaunch text first when both are due', () => {
    const t = {
      sessionId: 'sess-old',
      title: 'My task',
      messages: [] as Message[],
    }
    applyDueMessages(t, [{ text: 'ordinary' }, { text: 'relaunch', relaunch: true }], AT)
    expect('sessionId' in t).toBe(false)
    // One divider, not one per entry.
    expect((t as { events?: TaskEvent[] }).events).toHaveLength(1)
    // The relaunch text leads so the fresh session reads it first.
    expect(t.messages.map((m) => m.text)).toEqual(['relaunch', 'ordinary'])
    expect((t as { queued?: string[] }).queued).toEqual(['relaunch', 'ordinary'])
  })

  it('re-arms the next occurrence when a repeating relaunch delivers', () => {
    const t = {
      sessionId: 'sess-old',
      title: 'My task',
      messages: [] as Message[],
      scheduledMessages: undefined as ScheduledMessage[] | undefined,
    }
    applyDueMessages(
      t,
      [{ text: 'go', relaunch: true, repeat: { interval: 60, remaining: 2 } }],
      AT,
    )
    // The delivered occurrence fired; its successor is armed one interval later
    // with a decremented count.
    expect(t.scheduledMessages).toEqual([
      {
        text: 'go',
        deliverAt: '2026-06-01T01:00:00.000Z',
        relaunch: true,
        repeat: { interval: 60, remaining: 1 },
      },
    ])
  })

  it('does not re-arm when the repeating series has reached its bound', () => {
    const t = {
      sessionId: 'sess-old',
      title: 'My task',
      messages: [] as Message[],
      scheduledMessages: undefined as ScheduledMessage[] | undefined,
    }
    applyDueMessages(
      t,
      [{ text: 'go', relaunch: true, repeat: { interval: 60, remaining: 0 } }],
      AT,
    )
    expect(t.scheduledMessages).toBeUndefined()
  })
})

describe('worktreeName', () => {
  const project = '/home/me/proj'

  it('returns the name of a worktree directly under the worktrees dir', () => {
    expect(worktreeName(project, '/home/me/proj/.claude/worktrees/feat-x')).toBe(
      'feat-x',
    )
  })

  it('keeps a slash-segmented worktree name whole', () => {
    expect(
      worktreeName(project, '/home/me/proj/.claude/worktrees/feature/x'),
    ).toBe('feature/x')
  })

  it('rejects a path outside this project (never sets a bogus flag)', () => {
    expect(worktreeName(project, '/somewhere/else/.claude/worktrees/x')).toBe(
      undefined,
    )
    expect(worktreeName(project, '/home/me/proj/server')).toBe(undefined)
  })

  it('rejects the worktrees dir itself', () => {
    expect(worktreeName(project, '/home/me/proj/.claude/worktrees')).toBe(
      undefined,
    )
  })
})
