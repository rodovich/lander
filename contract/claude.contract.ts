import { beforeAll, describe, expect, it } from 'vitest'
import { makeFlow } from '../daemon/flows/claude'
import {
  TASK_PROMPT,
  cliVersion,
  driveLive,
  landerStub,
  replyText,
  runJsonl,
  scratchDir,
  type LiveTurn,
} from './live'

const VERSION = cliVersion('claude')

describe.skipIf(!VERSION)(`claude contract (${VERSION})`, () => {
  const flow = makeFlow({
    landerBin: landerStub(),
    taskPromptTemplate: TASK_PROMPT,
    readProjectDoc: () => undefined,
  })

  // One two-turn session, shared by the session and cost checks below.
  let root: string
  let first: LiveTurn
  let second: LiveTurn
  beforeAll(async () => {
    root = scratchDir({ git: true })
    first = await driveLive(flow, {
      root,
      prompt: 'Remember the codeword PLUM-7. Reply with exactly: ok. Use no tools.',
    })
    second = await driveLive(flow, {
      root,
      prior: first.task,
      prompt: 'What codeword did I give you? Reply with just the codeword. Use no tools.',
    })
  }, 360_000)

  it('resumes the session it minted, with the earlier turn in context', () => {
    expect(first.result.exitCode).toBe(0)
    expect(second.result.exitCode).toBe(0)
    const sessionId = first.task.flowState?.sessionId
    expect(typeof sessionId).toBe('string')
    expect(second.task.flowState?.sessionId).toBe(sessionId)
    expect(replyText(second)).toContain('PLUM-7')
  })

  // Since CLI 2.1.278, total_cost_usd and modelUsage are the session's running
  // totals across --resume, while result.usage is the turn's own; the flow
  // charges each turn the difference (server/stream.ts sessionCost).
  it("charges each turn its own share of the session's running cost", () => {
    const a = first.ride.usage!
    const b = second.ride.usage!
    expect(a.costUsd).toBeGreaterThan(0)
    expect(a.costUsd).toBeCloseTo(a.sessionCostUsd!, 10)
    expect(b.sessionCostUsd!).toBeGreaterThan(a.sessionCostUsd!)
    expect(b.costUsd).toBeCloseTo(b.sessionCostUsd! - a.sessionCostUsd!, 10)
  })

  it("reports running session tokens that grow by exactly the turn's own usage", () => {
    const totals = (t: LiveTurn) =>
      t.task.flowState?.sessionTotals as { costUsd: number; tokens: number }
    const own = second.ride.usage!
    const turnTokens = own.input + own.output + own.cacheRead + own.cacheCreation
    // A tool-free turn has no side-model calls, so modelUsage and usage agree.
    expect(totals(second).tokens - totals(first).tokens).toBe(turnTokens)
  })

  // The grant flow end to end: a refused call is folded as blocked with the rule
  // the UI offers, and a task holding that rule gets the same call through.
  it('blocks a refused call, and the rule it offers lets the call through', async () => {
    const prompt =
      'Call the WebFetch tool exactly once with url "https://example.com/" and prompt ' +
      '"What is the page title?", then report the title. Use no other tool. ' +
      'If the fetch is refused, reply DENIED.'
    const fetches = (turn: LiveTurn) =>
      (turn.task.items as {
        kind: string
        name?: string
        status?: string
        rule?: string
        output?: string
      }[])
        .filter((it) => it.kind === 'tool' && it.name === 'WebFetch')

    const refused = await driveLive(flow, { root: scratchDir({ git: true }), prompt })
    const blocked = fetches(refused)
    expect(blocked.length).toBeGreaterThan(0)
    expect(blocked.every((it) => it.status === 'blocked')).toBe(true)
    const rule = blocked[0].rule
    expect(rule).toBeTruthy()

    const granted = await driveLive(flow, {
      root: scratchDir({ git: true }),
      prompt,
      allow: [rule!],
    })
    // Permission is the contract. A malformed call (the model omitting a
    // parameter) is rejected before the permission check, so it proves nothing
    // either way; require no refusal and at least one call that reached the
    // check and ran. A fetch that ran can still fail on the network.
    const calls = fetches(granted)
      .map((it) => ({ rule, status: it.status, output: it.output }))
      .filter((it) => !it.output?.includes('InputValidationError'))
    expect(calls.filter((it) => it.status === 'blocked')).toEqual([])
    expect(calls.length, 'no well-formed WebFetch call to judge').toBeGreaterThan(0)
  })

  it('fails a turn on an unusable model with a non-zero exit', () => {
    const r = runJsonl(
      'claude',
      ['-p', '--model', 'definitely-not-a-model', '--output-format', 'json', '--', 'say ok'],
      { cwd: scratchDir({ git: true }) },
    )
    // The flow detects a failed turn by exit code alone.
    expect(r.exit).not.toBe(0)
    expect(r.lines.find((l) => l.type === 'result')?.is_error).toBe(true)
  })
})
