import { describe, it, expect } from 'vitest'
import { blockedRequests, type BlockedStep } from './permissions'

const AT = '2026-01-01T00:00:00.000Z'

const use = (
  toolUseId: string,
  tool: string,
  rule: string | undefined,
  parentToolUseId?: string,
): BlockedStep => ({
  kind: 'tool_use',
  tool,
  ...(rule !== undefined ? { rule } : {}),
  toolUseId,
  ...(parentToolUseId ? { parentToolUseId } : {}),
})

const result = (
  toolUseId: string,
  blocked: boolean,
  parentToolUseId?: string,
): BlockedStep => ({
  kind: 'tool_result',
  toolUseId,
  blocked,
  ...(parentToolUseId ? { parentToolUseId } : {}),
})

describe('blockedRequests', () => {
  it('returns nothing when no result is blocked', () => {
    const steps = [use('t1', 'Bash', 'Bash(ls)'), result('t1', false)]
    expect(blockedRequests(steps)).toEqual([])
  })

  it('pairs a blocked result to its call and surfaces the rule', () => {
    const steps = [
      use('t1', 'Bash', 'Bash(git push)'),
      result('t1', true),
    ]
    expect(blockedRequests(steps)).toEqual([
      { key: 'Bash(git push)', rule: 'Bash(git push)', tool: 'Bash' },
    ])
  })

  it('dedupes by rule — the same denied command thrice is one row', () => {
    const steps = [
      use('t1', 'Bash', 'Bash(git push)'),
      result('t1', true),
      use('t2', 'Bash', 'Bash(git push)'),
      result('t2', true),
      use('t3', 'Bash', 'Bash(git push)'),
      result('t3', true),
    ]
    expect(blockedRequests(steps)).toEqual([
      { key: 'Bash(git push)', rule: 'Bash(git push)', tool: 'Bash' },
    ])
  })

  it('keeps distinct rules as separate rows, in first-seen order', () => {
    const steps = [
      use('t1', 'Bash', 'Bash(git push)'),
      result('t1', true),
      use('t2', 'WebFetch', 'WebFetch(https://x)'),
      result('t2', true),
    ]
    expect(blockedRequests(steps).map((r) => r.rule)).toEqual([
      'Bash(git push)',
      'WebFetch(https://x)',
    ])
  })

  it('includes a subagent denial (parentToolUseId set)', () => {
    const steps = [
      use('sub', 'Bash', 'Bash(rm -rf /)', 'spawner'),
      result('sub', true, 'spawner'),
    ]
    expect(blockedRequests(steps)).toEqual([
      { key: 'Bash(rm -rf /)', rule: 'Bash(rm -rf /)', tool: 'Bash' },
    ])
  })

  it('falls back to the bare tool name for a call recorded before the rule field', () => {
    const steps = [use('t1', 'Bash', undefined), result('t1', true)]
    expect(blockedRequests(steps)).toEqual([
      { key: 'Bash', rule: 'Bash', tool: 'Bash' },
    ])
  })

  it('ignores an isError result that was not a permission denial', () => {
    const steps = [
      use('t1', 'Bash', 'Bash(flaky)'),
      { kind: 'tool_result', toolUseId: 't1', blocked: false } as BlockedStep,
    ]
    expect(blockedRequests(steps)).toEqual([])
  })

  it('skips a blocked result with no matching call', () => {
    const steps = [result('orphan', true)]
    expect(blockedRequests(steps)).toEqual([])
  })
})
