import { existsSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeFlow } from '../daemon/flows/codex'
import { captureDriverTurn } from '../daemon/flows/testCtx'
import {
  TASK_PROMPT,
  cliVersion,
  driveLive,
  replyText,
  runJsonl,
  scratchDir,
  type LiveTurn,
} from './live'

const VERSION = cliVersion('codex')

// Probes don't need depth; keep their reasoning (and quota) small.
const PROBE_CONFIG = ['model_reasoning_effort="low"']

describe.skipIf(!VERSION)(`codex contract (${VERSION})`, () => {
  const flow = makeFlow({
    taskPromptTemplate: TASK_PROMPT,
    readProjectDoc: () => undefined,
    configOverrides: PROBE_CONFIG,
  })

  // One two-turn thread, shared by the resume check.
  let first: LiveTurn
  let second: LiveTurn
  beforeAll(async () => {
    const root = scratchDir({ git: true })
    first = await driveLive(flow, {
      root,
      prompt: 'Remember the codeword PLUM-7. Reply with exactly: ok. Run no commands.',
    })
    second = await driveLive(flow, {
      root,
      prior: first.task,
      prompt: 'What codeword did I give you? Reply with just the codeword. Run no commands.',
    })
  }, 360_000)

  it('resumes the thread it started, with the earlier turn in context', () => {
    expect(first.result.exitCode).toBe(0)
    expect(second.result.exitCode).toBe(0)
    const threadId = first.task.flowState?.sessionId
    expect(typeof threadId).toBe('string')
    expect(second.task.flowState?.sessionId).toBe(threadId)
    expect(replyText(second)).toContain('PLUM-7')
  })

  // turn.completed.usage is the thread's running total, restored on resume
  // (codex exec builds it from the thread total; 0.145–0.153 lost the restore to
  // a decoding bug, fixed in 0.154.0). Two near-identical tiny turns: a running
  // total roughly doubles, a per-turn figure stays about level.
  it('reports turn.completed usage as a running thread total across a resume', () => {
    const cwd = scratchDir({ git: true })
    const args = (prompt: string) => [...PROBE_CONFIG.flatMap((c) => ['-c', c]), '--', prompt]
    const fresh = runJsonl('codex', ['exec', '--json', ...args('Reply with exactly: one. Run no commands.')], { cwd })
    const thread = fresh.lines.find((l) => l.type === 'thread.started')?.thread_id
    expect(thread).toBeTruthy()
    const resumed = runJsonl(
      'codex',
      ['exec', '--json', 'resume', thread, ...args('Reply with exactly: two. Run no commands.')],
      { cwd },
    )
    const usage = (r: typeof fresh) => r.lines.find((l) => l.type === 'turn.completed')?.usage
    const a = usage(fresh)
    const b = usage(resumed)
    expect(a?.input_tokens).toBeGreaterThan(0)
    expect(b?.input_tokens).toBeGreaterThan(1.5 * a.input_tokens)
    expect(b.output_tokens).toBeGreaterThan(a.output_tokens)
  })

  it('runs a turn in a project that is not a git repo', async () => {
    const turn = await driveLive(flow, {
      root: scratchDir({ git: false }),
      prompt: 'Reply with exactly: ok. Run no commands.',
    })
    expect(turn.result.exitCode).toBe(0)
    expect(replyText(turn)).toContain('ok')
  })

  // Codex ignores an unknown -c key unless --strict-config is passed, so a
  // renamed permission or env key would silently drop lander's sandbox scoping.
  // Rerun the argv lander builds, strictly.
  it.each([
    ['read-only', false],
    ['edit', true],
  ])("accepts lander's %s config overrides under --strict-config", async (_label, allowEdits) => {
    const root = scratchDir({ git: true })
    const { args } = await captureDriverTurn(flow, {
      task: { allowEdits },
      root,
      cwd: root,
      prompt: 'Reply with exactly: ok. Run no commands.',
    })
    const strict = [...args]
    strict.splice(strict.indexOf('exec') + 1, 0, '--strict-config')
    const r = runJsonl('codex', strict, { cwd: root })
    expect(r.stderr).not.toMatch(/unknown configuration field/)
    expect(r.exit).toBe(0)
  })

  it('rejects an unknown config key under --strict-config (control)', () => {
    const r = runJsonl(
      'codex',
      ['exec', '--json', '--strict-config', '-c', 'default_permisions="x"', '--', 'say ok'],
      { cwd: scratchDir({ git: true }) },
    )
    expect(r.exit).not.toBe(0)
    expect(r.stderr).toMatch(/unknown configuration field/)
  })

  // The sandbox profile the flow selects: read-only keeps the workspace
  // unwritable; edit access opens it.
  it.each([
    ['read-only', false, false],
    ['edit', true, true],
  ])('a %s task %s write the workspace', async (_label, allowEdits, writes) => {
    const root = scratchDir({ git: true })
    await driveLive(flow, {
      root,
      allowEdits,
      prompt:
        'Run exactly this shell command once and nothing else: touch contract-probe.txt ' +
        '— then reply with the command output or error.',
    })
    expect(existsSync(path.join(root, 'contract-probe.txt'))).toBe(writes)
  })
})
