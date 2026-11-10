// The task prompt template carries an {{id}} slot so the agent is told its own
// task id up front — an agent that knows its id won't mistake its own row in
// `lander list` for a separate "sibling" task (see task DrNwYlXD7L). These lock
// the substitution and guard against a leftover placeholder reaching the child.

import { describe, expect, it } from 'vitest'
import { buildRevivedBlock, buildScheduledRideBlock } from './flows/ctx'
import {
  changedContextParts,
  deliveryDigest,
  fillTaskPrompt,
  prepareUserMessagePrompt,
  taskContextParts,
  watchersPart,
} from './task-management'

const TEMPLATE = 'You are running inside a lander task. This task id is {{id}}.'

describe('changedContextParts', () => {
  const git = { key: 'git', text: 'on main' }
  const cwd = { key: 'cwd', text: 'ended in sub', everyTurn: true as const }

  it('sends every part with no session or no record in this form', () => {
    expect(changedContextParts([git], undefined, { git: deliveryDigest('on main') }).send).toEqual([git])
    expect(changedContextParts([git], 's', 'an old block string').send).toEqual([git])
  })

  it('sends only parts that changed, and an every-turn part whenever it applies', () => {
    const first = changedContextParts([git, cwd], 's', undefined)
    expect(first.record).toEqual({ git: deliveryDigest('on main') })
    const again = changedContextParts([git, cwd], 's', first.record)
    expect(again).toEqual({ send: [cwd], record: first.record, changed: false })
    const moved = changedContextParts([{ key: 'git', text: 'on topic' }], 's', first.record)
    expect(moved.send.map((p) => p.text)).toEqual(['on topic'])
    expect(moved.changed).toBe(true)
  })

  it('counts a part that went away as a change to record', () => {
    const r = changedContextParts([], 's', { git: deliveryDigest('on main') })
    expect(r).toEqual({ send: [], record: {}, changed: true })
  })

  it('tells the agent once when every watcher has been switched off', () => {
    const r = changedContextParts([], 's', { watchers: 'sha256:x' })
    expect(r.send.map((p) => p.text)).toEqual([
      'No watchers are enabled anymore; `lander ride --watch` will refuse.',
    ])
    expect(changedContextParts([], 's', r.record).send).toEqual([])
  })

  it('replaces a record left from an earlier session, so it is never retracted', () => {
    const fresh = changedContextParts([], undefined, { watchers: 'sha256:x' })
    expect(fresh).toEqual({ send: [], record: {}, changed: true })
    expect(changedContextParts([], 's', fresh.record).send).toEqual([])
  })
})

const WATCHER = {
  name: 'gh-pr-activity',
  description: 'Fires when someone responds.',
  args: {
    pr: { required: true, description: 'owner/repo#123' },
    since: { description: 'an ISO time' },
  },
}

describe('watchersPart', () => {
  it('lists each enabled watcher with its arguments', () => {
    expect(watchersPart({ watchers: [WATCHER] })?.text).toBe(
      'Watchers you can arm with `lander ride --watch <watcher> --arg <key>=<value>`:\n' +
        '- `gh-pr-activity`: Fires when someone responds.\n' +
        '  - `--arg pr=…` (required): owner/repo#123\n' +
        '  - `--arg since=…`: an ISO time',
    )
    expect(watchersPart({ watchers: [] })).toBeUndefined()
  })

  it('reaches a user-message prompt once, and again only when the list changes', () => {
    const store: Record<string, unknown> = {}
    const ctx = {
      task: { taskId: 't1', root: '/repo', watchers: [WATCHER] },
      turn: { prompts: ['go'] },
      state: {
        get: (p: string[]) => store[p[0]],
        set: (p: string[], v: unknown) => void (store[p[0]] = v),
      },
    }
    const opts = { sessionId: 'thread-1', taskPromptTemplate: TEMPLATE, readProjectDoc: () => undefined }
    const first = prepareUserMessagePrompt(ctx, opts)
    expect(first.prompt).toContain('`gh-pr-activity`')
    first.commitDelivered()
    expect(prepareUserMessagePrompt(ctx, opts).prompt).not.toContain('`gh-pr-activity`')
    ctx.task.watchers = []
    expect(prepareUserMessagePrompt(ctx, opts).prompt).toContain('No watchers are enabled anymore')
  })
})

describe('the app part', () => {
  it('says nothing about an app that was never reported running', () => {
    expect(changedContextParts([], undefined, undefined).send).toEqual([])
    expect(changedContextParts([], 's', {}).send).toEqual([])
  })

  it('is among the parts a Claude turn gets', () => {
    const parts = taskContextParts(
      { cwd: '/repo', root: '/repo', app: { url: 'http://localhost:5173' } },
      () => undefined,
    )
    expect(parts.map((p) => p.key)).toEqual(['app'])
  })

  it('tells the agent about a running app, then once that it has stopped', () => {
    const store: Record<string, unknown> = {}
    const ctx: {
      task: { taskId: string; root: string; app?: { url: string } }
      turn: { prompts: string[] }
      state: { get: (p: string[]) => unknown; set: (p: string[], v: unknown) => void }
    } = {
      task: { taskId: 't1', root: '/repo', app: { url: 'http://localhost:3860' } },
      turn: { prompts: ['go'] },
      state: {
        get: (p) => store[p[0]],
        set: (p, v) => void (store[p[0]] = v),
      },
    }
    const opts = { sessionId: 'thread-1', taskPromptTemplate: TEMPLATE, readProjectDoc: () => undefined }
    const running = prepareUserMessagePrompt(ctx, opts)
    expect(running.prompt).toContain(
      "This checkout's app is running at http://localhost:3860, started by the user through lander.",
    )
    running.commitDelivered()
    expect(prepareUserMessagePrompt(ctx, opts).prompt).not.toContain('localhost:3860')
    delete ctx.task.app
    const stopped = prepareUserMessagePrompt(ctx, opts)
    expect(stopped.prompt).toContain('is no longer running')
    stopped.commitDelivered()
    expect(prepareUserMessagePrompt(ctx, opts).prompt).not.toContain('no longer running')
  })
})

describe('fillTaskPrompt', () => {
  it('substitutes {{id}} and leaves no placeholder', () => {
    const out = fillTaskPrompt(TEMPLATE, 'abc123')
    expect(out).toContain('This task id is abc123.')
    expect(out).not.toContain('{{')
  })
})

// The wording is deliberate and deliberately minimal — it states what happened
// and stops. The one exception is the cleared-timer clause, which does point at
// `lander ride`: there the agent has lost something it may want back, and naming
// the remedy is the difference between a notice and a usable one. Asserted
// byte-for-byte so a later "helpful" embellishment has to be a decision.
describe('buildRevivedBlock', () => {
  it('renders the wedged notice', () => {
    expect(buildRevivedBlock({ from: 'wedged' })).toBe(
      '<task-revived>\n' +
        'You were wedged when this message arrived; the message changed your status to riding.\n' +
        '</task-revived>',
    )
  })

  it('renders the landed notice with the same one sentence', () => {
    expect(buildRevivedBlock({ from: 'landed' })).toBe(
      '<task-revived>\n' +
        'You were landed when this message arrived; the message changed your status to riding.\n' +
        '</task-revived>',
    )
  })

  // The common shape of the cleared-ride case: nothing notable was crossed, so
  // "waiting" is all there is to say about it.
  it('names a cleared scheduled ride, its time, and the way to schedule it again', () => {
    expect(buildRevivedBlock({ waitingUntil: '8/7/2026, 3:00:00 PM' })).toBe(
      '<task-revived>\n' +
        'You were waiting until 8/7/2026, 3:00:00 PM when this message arrived; ' +
        'the message changed your status to riding and cleared the ride you had ' +
        'scheduled for then. Schedule it again with `lander ride` if you still want it.\n' +
        '</task-revived>',
    )
  })

  // Both halves at once — a wedged task holding a deferred session-limit retry
  // ride, revived by a message. One sentence, not two notices.
  it('folds a crossed status and a cleared ride into one sentence', () => {
    expect(
      buildRevivedBlock({ from: 'wedged', waitingUntil: '3:00:00 PM' }),
    ).toBe(
      '<task-revived>\n' +
        'You were wedged until 3:00:00 PM when this message arrived; ' +
        'the message changed your status to riding and cleared the ride you had ' +
        'scheduled for then. Schedule it again with `lander ride` if you still want it.\n' +
        '</task-revived>',
    )
  })
})

describe('buildScheduledRideBlock', () => {
  const sentence = (when: string) =>
    '<ride-scheduled>\n' +
    `You have a ride scheduled ${when}. Calling \`lander ride\` replaces the ` +
    'scheduled ride; `lander ride --clear` clears it.\n' +
    '</ride-scheduled>'

  it('names the time of a time trigger', () => {
    expect(buildScheduledRideBlock({ at: '10/10/2026, 1:21:00 PM' })).toBe(
      sentence('for 10/10/2026, 1:21:00 PM'),
    )
  })

  it('names the awaited tasks of an await', () => {
    expect(buildScheduledRideBlock({ awaiting: ['a1'] })).toBe(
      sentence('for when a1 lands'),
    )
    expect(buildScheduledRideBlock({ awaiting: ['a1', 'b2'] })).toBe(
      sentence('for when a1, b2 have all landed'),
    )
  })

  it('names both triggers of a ride that has both', () => {
    expect(buildScheduledRideBlock({ at: '1:21:00 PM', awaiting: ['a1'] })).toBe(
      sentence('for 1:21:00 PM or when a1 lands, whichever comes first'),
    )
  })

  it('names a watch’s watcher and arguments', () => {
    expect(
      buildScheduledRideBlock({
        watching: { watcher: 'file-changed', args: { path: 'out.log' } },
      }),
    ).toBe(
      '<ride-scheduled>\n' +
        'You are watching `file-changed` (path=out.log); it wakes you once when ' +
        'it fires. Calling `lander ride` replaces the watch; `lander ride --clear` ' +
        'clears it.\n' +
        '</ride-scheduled>',
    )
  })
})

describe('prepareUserMessagePrompt', () => {
  function makeCtx(
    initial: Record<string, unknown> = {},
    checkout?: string,
  ) {
    const store = { ...initial }
    return {
      store,
      ctx: {
        task: { taskId: 't1', root: '/repo', ...(checkout ? { checkout } : {}) },
        turn: {
          prompts: ['do work'],
          manifestBlock: '<attached-files/>',
          revivedBlock: '<task-revived/>',
          scheduledRideBlock: '<ride-scheduled/>',
        },
        state: {
          get: (path: string[]) => store[path[0]],
          set: (path: string[], value: unknown) => {
            store[path[0]] = value
          },
        },
      },
    }
  }

  it('delivers task prompt and project doc on a fresh session and suppresses unchanged ones after commit', () => {
    const { store, ctx } = makeCtx({}, '/repo/.worktrees/t1')
    const docs: Record<string, string> = {
      '/repo': 'Root doc',
      '/repo/.worktrees/t1': 'Checkout doc',
    }
    const first = prepareUserMessagePrompt(ctx, {
      sessionId: undefined,
      taskPromptTemplate: TEMPLATE,
      readProjectDoc: (dir) => docs[dir],
    })
    expect(first.prompt).toContain('This task id is t1.')
    expect(first.prompt).toContain('git worktree lander created for it at `/repo/.worktrees/t1`')
    expect(first.prompt).toContain('Checkout doc')
    expect(first.prompt).not.toContain('Root doc')
    expect(first.prompt).toContain(
      'do work\n\n<attached-files/>\n\n<task-revived/>\n\n<ride-scheduled/>',
    )
    expect(store).toEqual({})

    first.commitDelivered()
    expect(store.taskPrompt).toMatch(/^sha256:/)
    expect(store.landerDoc).toBe(deliveryDigest('Checkout doc'))

    const second = prepareUserMessagePrompt(ctx, {
      sessionId: 'sess-1',
      taskPromptTemplate: TEMPLATE,
      readProjectDoc: (dir) => docs[dir],
    })
    expect(second.prompt).toBe(
      'do work\n\n<attached-files/>\n\n<task-revived/>\n\n<ride-scheduled/>',
    )
  })
})
