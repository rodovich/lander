import { describe, expect, it } from 'vitest'
import { CHILD_RESULTS_MAX_CHARS, childResults, settled, wakeDue, type Family, type FamilyTask } from './managed'

const AT = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString()

let seq = 0
type RideSpec = { from?: object | null; text?: string; open?: boolean; outcome?: string }

function task(id: string, rides: RideSpec[] = [], over: Partial<FamilyTask> = {}): FamilyTask {
  const items: FamilyTask['items'] = []
  const built = rides.map((r) => {
    const rideId = `r${++seq}`
    const at = AT(seq)
    if (r.from !== undefined)
      items.push({
        id: `u${seq}`,
        at,
        kind: 'message',
        role: 'user',
        text: 'go',
        deliveredIn: rideId,
        ...(r.from ? { from: r.from } : {}),
      } as never)
    if (r.text)
      items.push({ id: `f${seq}`, at, rideId, kind: 'message', role: 'flow', text: r.text } as never)
    return {
      id: rideId,
      startedAt: at,
      ...(r.open ? {} : { endedAt: at, outcome: r.outcome ?? 'done' }),
    }
  })
  return { id, status: 'riding', rides: built as never, items, ...over }
}

const fromParent = { task: 'P', via: 'launch' }
const fromSibling = { task: 'B', via: 'send' }

function family(tasks: FamilyTask[], edges: Record<string, string[]>, over: Partial<Family> = {}): Family {
  return {
    tasks: new Map(tasks.map((t) => [t.id, t])),
    childrenOf: (id) => edges[id] ?? [],
    driving: () => false,
    awaitingAnswer: new Set(),
    ...over,
  }
}

describe('childResults', () => {
  it('includes rides the parent started plus the last', () => {
    const a = task('A', [{ from: fromParent, text: 'joke' }, { from: fromSibling, text: 'iguana' }])
    const r = childResults(task('P'), [a])!
    expect(r.text).toContain('joke')
    expect(r.text).toContain('iguana')
  })

  it('notes rides left out between them', () => {
    const a = task('A', [
      { from: fromParent, text: 'joke' },
      { from: fromSibling, text: 'skipped' },
      { from: fromSibling, text: 'last' },
    ])
    const r = childResults(task('P'), [a])!
    expect(r.text).not.toContain('skipped')
    expect(r.text).toContain('1 other turn not shown')
  })

  it('leaves out rides the parent has seen, and records what it delivers', () => {
    const a = task('A', [{ from: fromParent, text: 'old' }, { from: fromParent, text: 'new' }])
    const parent = task('P', [], { childrenSeen: { A: a.rides![0].endedAt! } })
    const r = childResults(parent, [a])!
    expect(r.text).not.toContain('old')
    expect(r.seen).toEqual({ A: a.rides![1].endedAt })
    expect(childResults(task('P', [], { childrenSeen: r.seen }), [a])).toBeUndefined()
  })

  it('names a ride that ended without a reply', () => {
    const a = task('A', [{ from: fromParent, outcome: 'error' }])
    expect(childResults(task('P'), [a])!.text).toContain('ended without a reply: error')
  })

  it('marks a partial reply from a ride that was cut short', () => {
    const a = task('A', [{ from: fromParent, text: 'Let me start by', outcome: 'interrupted' }])
    expect(childResults(task('P'), [a])!.text).toContain('cut short: interrupted')
  })

  it('counts unread messages in place of replies too long to include', () => {
    const long = 'x'.repeat(CHILD_RESULTS_MAX_CHARS)
    const a = task('A', [
      { from: fromParent, text: 'seen' },
      { from: null, text: 'by the user' },
      { from: fromParent, text: long },
    ])
    const b = task('B', [{ from: fromParent, text: 'short' }])
    const parent = task('P', [], { childrenSeen: { A: a.rides![0].endedAt! } })
    const r = childResults(parent, [a, b])!
    expect(r.text).not.toContain(long)
    expect(r.text).toContain('lander view <id> --messages <N>')
    expect(r.text).toMatch(/^A \[paced\]: 4 messages, [\d,]+ characters$/m)
    expect(r.text).toMatch(/^B \[paced\]: 1 message, 5 characters$/m)
    expect(r.seen).toEqual({ A: a.rides![2].endedAt, B: b.rides![0].endedAt })
  })

  it('leaves out a ride still running', () => {
    expect(childResults(task('P'), [task('A', [{ from: fromParent, open: true }])])).toBeUndefined()
  })
})

describe('wakeDue', () => {
  const done = () => task('A', [{ from: fromParent, text: 'done' }])

  it('wakes an idle parent once its children have settled', () => {
    expect(wakeDue('P', family([task('P'), done()], { P: ['A'] }))).toBe(true)
  })

  it('waits for a child still riding', () => {
    const b = task('B', [{ from: fromParent, open: true }])
    expect(wakeDue('P', family([task('P'), done(), b], { P: ['A', 'B'] }))).toBe(false)
  })

  it('does not wake for a ride only the user started', () => {
    const a = task('A', [{ from: null, text: 'for the user' }])
    expect(wakeDue('P', family([task('P'), a], { P: ['A'] }))).toBe(false)
  })

  it('treats a resumed ride as started by whoever started the ride before it', () => {
    const resumed = { from: { lander: 'restart' }, text: 'resumed' }
    const seenFirst = (a: FamilyTask) => task('P', [], { childrenSeen: { A: a.rides![0].endedAt! } })
    const forParent = task('A', [{ from: fromParent, text: 'first' }, resumed])
    expect(wakeDue('P', family([seenFirst(forParent), forParent], { P: ['A'] }))).toBe(true)
    const forUser = task('A', [{ from: null, text: 'first' }, resumed])
    expect(wakeDue('P', family([seenFirst(forUser), forUser], { P: ['A'] }))).toBe(false)
  })

  it.each(['wedged', 'landed'])('leaves a %s parent alone', (status) => {
    expect(wakeDue('P', family([task('P', [], { status }), done()], { P: ['A'] }))).toBe(false)
  })

  it('leaves a parent mid-turn alone', () => {
    expect(wakeDue('P', family([task('P'), done()], { P: ['A'] }, { driving: (id) => id === 'P' }))).toBe(false)
  })

  it('leaves children the parent is waiting to see land out of the barrier', () => {
    const b = task('B', [{ from: fromParent, open: true }])
    expect(wakeDue('P', family([task('P', [], { waitingFor: ['B'] }), done(), b], { P: ['A', 'B'] }))).toBe(true)
  })

  it('stops once everything is seen', () => {
    const a = done()
    expect(wakeDue('P', family([task('P', [], { childrenSeen: { A: a.rides![0].endedAt! } }), a], { P: ['A'] }))).toBe(false)
  })
})

describe('settled', () => {
  const quiet = (over: Partial<FamilyTask> = {}) => task('A', [{ from: fromParent, text: 'done' }], over)

  it('is true of an idle child, and of a wedged one', () => {
    expect(settled('A', family([quiet()], {}))).toBe(true)
    expect(settled('A', family([quiet({ status: 'wedged' })], {}))).toBe(true)
  })

  it('is false with a message about to run', () => {
    expect(settled('A', family([quiet({ queued: ['next'] })], {}))).toBe(false)
  })

  it('is true of a deferred launch that has not started', () => {
    const deferred = task('A', [], { queued: ['opening'], scheduledFor: AT(99) })
    expect(settled('A', family([deferred], {}))).toBe(true)
  })

  it('is true of a deferred launch landed before it started', () => {
    expect(settled('A', family([task('A', [], { status: 'landed', queued: ['opening'] })], {}))).toBe(true)
  })

  it('is false with a wake still to deliver, or while awaiting an answer', () => {
    expect(settled('A', family([quiet({ pendingNotify: [{ to: 'B' }] })], {}))).toBe(false)
    expect(settled('A', family([quiet()], {}, { awaitingAnswer: new Set(['A']) }))).toBe(false)
  })

  it('is false while a grandchild runs, and until its result reaches the child', () => {
    const running = task('G', [{ from: { task: 'A', via: 'launch' }, open: true }])
    expect(settled('A', family([quiet(), running], { A: ['G'] }))).toBe(false)
    const finished = task('G', [{ from: { task: 'A', via: 'launch' }, text: 'ported' }])
    expect(settled('A', family([quiet(), finished], { A: ['G'] }))).toBe(false)
    const seen = quiet({ childrenSeen: { G: finished.rides![0].endedAt! } })
    expect(settled('A', family([seen, finished], { A: ['G'] }))).toBe(true)
  })
})
