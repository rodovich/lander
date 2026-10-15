import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { makeFlow, meta, resolveLaunchDir } from './agy'
import { announcedFlows, buildFlows, providerCaps } from './index'
import { driveFlow, goldenInput, type Golden } from './testCtx'
import { applyEvents } from './testTask'
import { deliveryDigest, projectDocBlock } from 'lander/flow'

const flow = (doc: string | undefined = 'Project instructions') => makeFlow({
  taskPromptTemplate: 'Task {{id}}. {{editAccess}}',
  readProjectDoc: () => doc,
})
const fixture = (chunks: string[][] = []): Golden => ({
  name: 'agy', chunks,
  start: { flow: 'agy', task: {} },
})
const event = (name: string, data: object) => JSON.stringify({ event: name, [name]: data })
const init = (conversation_id: string, data: object = {}) =>
  JSON.stringify({ event: 'init', conversation_id, init: data })
const result = (data: object = {}) => event('result', { status: 'SUCCESS', response: 'Done', ...data })
const patches = (events: Awaited<ReturnType<typeof driveFlow>>['events']) =>
  events.flatMap((e) => e.kind === 'state-patch' ? e.ops : [])
const steps = (events: Awaited<ReturnType<typeof driveFlow>>['events']) =>
  events.flatMap((e) => e.kind === 'update' ? e.steps ?? [] : [])

it('registers an executable driver and its capabilities', () => {
  expect(announcedFlows()).toContainEqual({ scope: 'bundled', meta })
  expect(providerCaps().agy).toMatchObject({ visionNative: false, projectGrants: false, usageSnapshot: false })
  expect(buildFlows({ root: process.cwd(), env: {} }).agy.meta).toEqual(meta)
  expect(resolveLaunchDir({ root: '/repo', recordedCwd: '/repo/sub', isDir: () => true })).toEqual({ cwd: '/repo/sub' })
  expect(resolveLaunchDir({ root: '/repo', recordedCwd: '/gone', isDir: () => false })).toEqual({ cwd: '/repo' })
})

it('reduces the recorded Antigravity stream into a session, tool lifecycle, usage, and reply', async () => {
  const lines = readFileSync(new URL('./fixtures/agy.jsonl', import.meta.url), 'utf8').trim().split('\n')
  const g = fixture([lines])
  const driven = await driveFlow(g, flow())
  const task = applyEvents(goldenInput(g).start, driven.events)
  expect(task).toMatchObject({
    flowState: {
      sessionId: JSON.parse(lines[0]).conversation_id,
      threadUsage: { input: 14767, output: 94, cacheRead: 10502, cacheCreation: 0 },
    },
    rides: [
      expect.objectContaining({
        usage: { input: 14767, output: 94, cacheRead: 10502, cacheCreation: 0 },
      }),
    ],
  })
  expect(steps(driven.events)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'tool_use', tool: 'run_command', input: 'printf agy-golden' }),
    expect.objectContaining({ kind: 'tool_result', text: 'agy-golden' }),
    expect.objectContaining({ kind: 'text', text: 'Golden complete.\n' }),
  ]))
  expect(driven.events).toContainEqual(expect.objectContaining({ kind: 'update', finalText: 'Golden complete.\n' }))
  expect(driven.result.exitCode).toBe(0)
})

it('formats tool inputs, file-edit diffs, subagent summaries, and truncated outputs', async () => {
  const toolStep = (
    step_index: number,
    tool_name: string,
    parameters?: object,
    extra: object = {},
  ) =>
    event('step_update', {
      step_index,
      step_type: 'tool',
      state: 'DONE',
      tool_name,
      tool_info: { ...(parameters ? { parameters } : {}) },
      ...extra,
    })
  const g = fixture([[
    toolStep(1, 'run_command', { CommandLine: 'npm test\nnpm run typecheck' }, { state: 'ACTIVE' }),
    toolStep(1, 'run_command', undefined, { tool_info: { output: 'line 1\nline 2\nline 3\nline 4' } }),
    toolStep(2, 'view_file', { AbsolutePath: '/repo/src/app.ts', StartLine: 1, EndLine: 20 }),
    toolStep(3, 'list_dir', { DirectoryPath: '/repo/src' }),
    toolStep(4, 'grep_search', { Query: 'makeFlow', SearchPath: '/repo/daemon' }),
    toolStep(5, 'code_search', { Query: 'resolveLaunchDir', SearchPath: '/repo' }),
    toolStep(6, 'find_by_name', { Pattern: '*.test.ts', SearchDirectory: '/repo' }),
    toolStep(7, 'replace_file_content', {
      TargetFile: '/repo/src/app.ts',
      TargetContent: 'const x = 1',
      ReplacementContent: 'const x = 2',
    }),
    toolStep(8, 'multi_replace_file_content', {
      TargetFile: '/repo/src/multi.ts',
      ReplacementChunks: [
        { TargetContent: 'a', ReplacementContent: 'b' },
        { TargetContent: 'c', ReplacementContent: 'd' },
      ],
    }),
    toolStep(9, 'write_to_file', { TargetFile: '/repo/src/new.ts' }),
    toolStep(
      10,
      'invoke_subagent',
      {
        Subagents: [
          { TypeName: 'research', Role: 'Codebase Researcher', Prompt: 'Inspect the flow reducer.' },
        ],
      },
      {
        subagent_info: {
          subagents: [{ type_name: 'research', role: 'Codebase Researcher' }],
        },
      },
    ),
    result(),
  ]])
  const driven = await driveFlow(g, flow())
  expect(steps(driven.events)).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'run_command',
      input: 'npm test npm run typecheck',
      inputFull: 'npm test\nnpm run typecheck',
    }),
    expect.objectContaining({
      kind: 'tool_result',
      text: 'line 1\nline 2\nline 3\n…',
    }),
    expect.objectContaining({ kind: 'tool_use', tool: 'view_file', input: '/repo/src/app.ts' }),
    expect.objectContaining({ kind: 'tool_use', tool: 'list_dir', input: '/repo/src' }),
    expect.objectContaining({ kind: 'tool_use', tool: 'grep_search', input: 'makeFlow' }),
    expect.objectContaining({ kind: 'tool_use', tool: 'code_search', input: 'resolveLaunchDir' }),
    expect.objectContaining({ kind: 'tool_use', tool: 'find_by_name', input: '*.test.ts' }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'replace_file_content',
      input: '/repo/src/app.ts',
      edits: [{ old: 'const x = 1', new: 'const x = 2' }],
    }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'multi_replace_file_content',
      input: '/repo/src/multi.ts',
      edits: [
        { old: 'a', new: 'b' },
        { old: 'c', new: 'd' },
      ],
    }),
    expect.objectContaining({ kind: 'tool_use', tool: 'write_to_file', input: '/repo/src/new.ts' }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'invoke_subagent',
      input: 'research: Codebase Researcher',
      inputFull: 'research: Codebase Researcher\n\nInspect the flow reducer.',
    }),
  ]))
})

it('accounts for per-turn token usage deltas and drivingModel across conversation resumes', async () => {
  const firstTurn = fixture([[
    init('conv-usage', { model: 'gemini-3.1-pro' }),
    event('step_update', {
      step_index: 1,
      step_type: 'agent_response',
      state: 'DONE',
      text_delta: 'First turn',
      usage: { input_tokens: 1000, output_tokens: 80, thinking_tokens: 20, cache_read_tokens: 500, total_tokens: 1080 },
    }),
    result({
      response: 'First turn',
      usage: { input_tokens: 1000, output_tokens: 80, thinking_tokens: 20, cache_read_tokens: 500, total_tokens: 1080 },
    }),
  ]])
  const firstDriven = await driveFlow(firstTurn, flow())
  const afterFirst = applyEvents(goldenInput(firstTurn).start, firstDriven.events)
  expect(afterFirst).toMatchObject({
    rides: [{
      usage: {
        input: 1000,
        output: 80,
        cacheRead: 500,
        cacheCreation: 0,
        model: 'gemini-3.1-pro',
      },
    }],
  })

  const secondTurn = fixture([[
    init('conv-usage', { model: 'gemini-3.1-pro' }),
    event('step_update', {
      step_index: 2,
      step_type: 'agent_response',
      state: 'DONE',
      text_delta: 'Second turn',
      usage: { input_tokens: 400, output_tokens: 30, thinking_tokens: 10, cache_read_tokens: 1200, total_tokens: 430 },
    }),
    result({
      response: 'Second turn',
      usage: { input_tokens: 1400, output_tokens: 110, thinking_tokens: 30, cache_read_tokens: 1700, total_tokens: 1510 },
    }),
  ]])
  secondTurn.start!.flowState = afterFirst.flowState as Record<string, unknown>
  const secondDriven = await driveFlow(secondTurn, flow())
  const afterSecond = applyEvents(goldenInput(secondTurn).start, secondDriven.events)
  expect(afterSecond).toMatchObject({
    rides: [{
      usage: {
        input: 400,
        output: 30,
        cacheRead: 1200,
        cacheCreation: 0,
        model: 'gemini-3.1-pro',
      },
    }],
    flowState: {
      threadUsage: {
        input: 1400,
        output: 110,
        cacheRead: 1700,
        cacheCreation: 0,
      },
    },
  })
})

it('passes prompts, cwd, scratch directories, and the Lander environment', async () => {
  const g = fixture([[result()]])
  g.start = { ...g.start, env: { LANDER_API: 'http://localhost', LANDER_TOKEN: 'secret', PATH: '/bin' } }
  g.input = { cwd: '/repo/sub', filesDir: '/tmp', materialized: { filesDir: '/tmp', images: [], manifestBlock: 'Attachment manifest' } }
  const driven = await driveFlow(g, flow())
  const spawn = driven.spawns[0]
  expect(spawn).toMatchObject({ command: 'agy', cwd: '/repo/sub', env: { LANDER_API: 'http://localhost', LANDER_TOKEN: 'secret', LANDER_FILES_DIR: '/tmp', LANDER_RUN: 'ride-1' } })
  expect(spawn.args).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--print-timeout', '0s', '--dangerously-skip-permissions', '--add-dir', '/tmp']))
  expect(spawn.args[1]).toContain('paths outside the workspace')
  expect(spawn.args[1]).toContain(projectDocBlock('Project instructions'))
  expect(spawn.args[1]).toContain('Attachment manifest')
  expect(spawn.args.filter((arg) => arg === '/tmp')).toHaveLength(1)
})

it('resumes without redelivering unchanged instructions and redelivers changed documents', async () => {
  const first = await driveFlow(fixture([[result()]]), flow())
  const state = Object.fromEntries(patches(first.events).map((op) => [op.path[0], op.value]))
  const g = fixture([[result()]])
  g.start!.flowState = { ...state, sessionId: 'conversation-1' }
  const resumed = await driveFlow(g, flow())
  expect(resumed.spawns[0].args).toContain('--conversation')
  expect(resumed.spawns[0].args).toContain('conversation-1')
  expect(resumed.spawns[0].args[1]).toBe('do the thing')
  const changed = await driveFlow(g, flow('Updated instructions'))
  expect(changed.spawns[0].args[1]).toContain(projectDocBlock('Updated instructions'))
  expect(patches(changed.events)).toContainEqual(expect.objectContaining({ path: ['landerDoc'], value: deliveryDigest('Updated instructions') }))
})

it('does not acknowledge prompt delivery when the provider fails before consuming it', async () => {
  const driven = await driveFlow(fixture([['not json', event('init', {}), result({ status: 'ERROR', response: '' })]]), flow())
  expect(driven.result.exitCode).toBe(1)
  expect(patches(driven.events)).toEqual([])
})

it('emits intermediate text, terminal tool errors, and a final response fallback', async () => {
  const g = fixture([[
    event('step_update', { step_index: 1, step_type: 'agent_response', text_delta: 'Checking' }),
    event('step_update', { step_index: 1, step_type: 'agent_response', text_delta: ' now' }),
    event('step_update', { step_index: 2, step_type: 'tool', state: 'ERROR', tool_info: { name: 'run_command', error: { message: 'Command failed' } } }),
    event('step_update', { step_index: 3, step_type: 'agent_response', text_delta: 'Finished' }),
    result({ response: undefined }),
  ]])
  const driven = await driveFlow(g, flow())
  expect(steps(driven.events).filter((step) => step.kind === 'text').map((step) => step.text)).toEqual(['Checking now', 'Finished'])
  expect(steps(driven.events)).toContainEqual(expect.objectContaining({ kind: 'tool_result', isError: true, text: 'Command failed' }))
  expect(driven.events).toContainEqual(expect.objectContaining({ kind: 'update', finalText: 'Finished' }))
})
