import { describe, it, expect } from 'vitest'
import {
  publicTask,
  latestUpdateAt,
  recordStatusTransition,
  pendingMessage,
  ensurePending,
  lastTurnPrompts,
  worktreeName,
  type Message,
  type TaskEvent,
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
