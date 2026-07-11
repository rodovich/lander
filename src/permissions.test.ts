import { describe, it, expect } from 'vitest'
import { blockedRequests, type BlockedItem } from './permissions'

const tool = (
  name: string,
  rule: string | undefined,
  status: string,
): BlockedItem => ({
  kind: 'tool',
  name,
  ...(rule !== undefined ? { rule } : {}),
  status,
})

describe('blockedRequests', () => {
  it('returns nothing when no tool is blocked', () => {
    expect(blockedRequests([tool('Bash', 'Bash(ls)', 'ok')])).toEqual([])
  })

  it('surfaces a blocked tool’s rule', () => {
    expect(blockedRequests([tool('Bash', 'Bash(git push)', 'blocked')])).toEqual([
      { key: 'Bash(git push)', rule: 'Bash(git push)', tool: 'Bash' },
    ])
  })

  it('dedupes by rule — the same denied command thrice is one row', () => {
    const items = [
      tool('Bash', 'Bash(git push)', 'blocked'),
      tool('Bash', 'Bash(git push)', 'blocked'),
      tool('Bash', 'Bash(git push)', 'blocked'),
    ]
    expect(blockedRequests(items)).toEqual([
      { key: 'Bash(git push)', rule: 'Bash(git push)', tool: 'Bash' },
    ])
  })

  it('keeps distinct rules as separate rows, in first-seen order', () => {
    const items = [
      tool('Bash', 'Bash(git push)', 'blocked'),
      tool('WebFetch', 'WebFetch(https://x)', 'blocked'),
    ]
    expect(blockedRequests(items).map((r) => r.rule)).toEqual([
      'Bash(git push)',
      'WebFetch(https://x)',
    ])
  })

  it('counts a subagent denial the same as a main-thread one', () => {
    // Nesting no longer matters: a blocked tool item is grantable whether or not
    // it was a subagent's, since there's no use/result pairing to trip over.
    expect(blockedRequests([tool('Bash', 'Bash(rm -rf /)', 'blocked')])).toEqual([
      { key: 'Bash(rm -rf /)', rule: 'Bash(rm -rf /)', tool: 'Bash' },
    ])
  })

  it('falls back to the bare tool name for a call recorded before the rule field', () => {
    expect(blockedRequests([tool('Bash', undefined, 'blocked')])).toEqual([
      { key: 'Bash', rule: 'Bash', tool: 'Bash' },
    ])
  })

  it('ignores a failed tool that was not a permission denial', () => {
    expect(blockedRequests([tool('Bash', 'Bash(flaky)', 'failed')])).toEqual([])
  })

  it('ignores running and ok tools, and non-tool items', () => {
    const items: BlockedItem[] = [
      tool('Bash', 'Bash(ls)', 'running'),
      tool('Read', 'Read(f)', 'ok'),
      { kind: 'message' },
    ]
    expect(blockedRequests(items)).toEqual([])
  })
})
