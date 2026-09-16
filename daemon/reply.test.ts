import { describe, expect, it, vi } from 'vitest'
import { createReply, type ReplyMessage } from './reply'

function harness() {
  const sent: ReplyMessage[] = []
  const reply = createReply((msg) => sent.push(msg))
  return { sent, reply }
}

describe('reply', () => {
  it('sends the body a handler returns', async () => {
    const h = harness()
    await h.reply('project-grant-result', 'r1', () => ({ ok: false, error: 'no', status: 404 }))
    expect(h.sent).toEqual([
      { type: 'project-grant-result', requestId: 'r1', ok: false, error: 'no', status: 404 },
    ])
  })

  it('sends the body an async handler resolves to', async () => {
    const h = harness()
    await h.reply('hook-run-result', 'r2', async () => ({
      ok: true,
      report: { outcome: 'ran' as const, reports: [] },
    }))
    expect(h.sent).toEqual([
      {
        type: 'hook-run-result',
        requestId: 'r2',
        ok: true,
        report: { outcome: 'ran', reports: [] },
      },
    ])
  })

  it('answers a synchronous throw instead of letting it escape', async () => {
    const h = harness()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const pending = h.reply('hooks-resolve-result', 'r3', () => {
      throw new Error('unknown slug')
    })
    await pending
    expect(h.sent).toEqual([
      { type: 'hooks-resolve-result', requestId: 'r3', ok: false, error: 'unknown slug', status: 500 },
    ])
  })

  it('answers a rejection', async () => {
    const h = harness()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await h.reply('project-grant-result', 'r4', async () => {
      throw new Error('disk full')
    })
    expect(h.sent).toEqual([
      { type: 'project-grant-result', requestId: 'r4', ok: false, error: 'disk full', status: 500 },
    ])
  })

  it('resolves only after the reply is sent', async () => {
    const h = harness()
    let release!: () => void
    const pending = h.reply('project-grant-result', 'r5', () =>
      new Promise((resolve) => {
        release = () => resolve({ ok: true })
      }),
    )
    let settled = false
    void pending.then(() => {
      settled = true
      expect(h.sent).toHaveLength(1)
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await pending
    expect(settled).toBe(true)
  })
})
