import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  agyUsageBody,
  agyProjectFile,
  agyProjectId,
  makeFlow,
  meta,
  normalizeAgyRule,
  onGrant,
  onStatus,
  agyRepromptMessage,
  resolveLaunchDir,
} from './agy'
import { announcedFlows, buildFlows, FLOW_MODULES, providerCaps } from './index'
import { driveFlow, goldenInput, type Golden } from './testCtx'
import { applyEvents } from './testTask'
import { blockedRequests, type BlockedItem } from '../../src/permissions'
import { deliveryDigest, projectDocBlock } from 'lander/flow'

let geminiConfigDir: string

beforeEach(() => {
  geminiConfigDir = mkdtempSync(path.join(tmpdir(), 'lander-agy-test-'))
})

afterEach(() => {
  rmSync(geminiConfigDir, { recursive: true, force: true })
})

const flow = (doc: string | undefined = 'Project instructions', log?: string) => makeFlow({
  taskPromptTemplate: 'Task {{id}}.',
  readProjectDoc: () => doc,
  geminiConfigDir,
  readAgyLog: () => log,
})
const refusalLine = (conversation: string, step: number) =>
  `I1019 11:03:49.944734     920 server.go:2611] Tool confirmation for conversation ${conversation} step ${step} (type=*gemini_coder_go_proto.Step_Generic approved=false)\n`
const fixture = (
  chunks: string[][] = [],
  flowState?: Record<string, unknown>,
): Golden => ({
  name: 'agy', chunks,
  start: { flow: 'agy', task: {}, ...(flowState ? { flowState } : {}) },
})
const event = (name: string, data: object) => JSON.stringify({ event: name, [name]: data })
const init = (conversation_id: string, data: object = {}) =>
  JSON.stringify({ event: 'init', conversation_id, init: data })
const result = (data: object = {}) => event('result', { status: 'SUCCESS', response: 'Done', ...data })
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
const patches = (events: Awaited<ReturnType<typeof driveFlow>>['events']) =>
  events.flatMap((e) => e.kind === 'state-patch' ? e.ops : [])
const steps = (events: Awaited<ReturnType<typeof driveFlow>>['events']) =>
  events.flatMap((e) => e.kind === 'update' ? e.steps ?? [] : [])

it('registers an executable driver and its capabilities', () => {
  expect(announcedFlows()).toContainEqual({ scope: 'bundled', meta })
  expect(providerCaps().agy).toMatchObject({ projectGrants: true, usageSnapshot: true })
  expect(FLOW_MODULES.agy.onGrant).toBe(onGrant)
  expect(FLOW_MODULES.agy.onStatus).toBe(onStatus)
  expect(buildFlows({ root: process.cwd(), env: {} }).agy.meta).toEqual(meta)
  expect(resolveLaunchDir({ root: '/repo', recordedCwd: '/repo/sub', isDir: () => true })).toEqual({ cwd: '/repo/sub' })
  expect(resolveLaunchDir({ root: '/repo', recordedCwd: '/gone', isDir: () => false })).toEqual({ cwd: '/repo' })
})

it('reads the Gemini group of /usage as used percentages', () => {
  const bucket = (id: string, remaining_fraction: number, reset_time: string) =>
    ({ id, window: id.endsWith('5h') ? '5h' : 'weekly', remaining_fraction, reset_time })
  const output = {
    status: 'SUCCESS',
    command: {
      name: 'usage',
      data: {
        groups: [
          { name: 'Gemini Models', buckets: [
            bucket('gemini-weekly', 0.75, '2026-10-23T22:23:42Z'),
            bucket('gemini-5h', 0.25, '2026-10-19T20:30:14Z'),
          ] },
          { name: 'Claude and GPT models', buckets: [
            bucket('3p-weekly', 1, '2026-10-26T19:45:43Z'),
            bucket('3p-5h', 1, '2026-10-20T00:45:43Z'),
          ] },
        ],
      },
    },
  }
  expect(agyUsageBody(output)).toEqual({
    session: { utilization: 75, resetsAt: '2026-10-19T20:30:14Z' },
    weekly: { utilization: 25, resetsAt: '2026-10-23T22:23:42Z' },
  })
  expect(agyUsageBody({ command: { name: 'usage', data: { groups: [] } } })).toBeNull()
})

it('keeps completed checkpoints in stream order without duplicating them or inventing compaction metadata', async () => {
  const checkpoint = (state: string) => event('step_update', {
    step_index: 2, step_type: 'checkpoint', state, duration_seconds: 0.53,
    usage: { input_tokens: 120, output_tokens: 8 },
  })
  const g = fixture([
    [init('checkpoint-session'), event('step_update', {
      step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'Before',
    }), checkpoint('ACTIVE')],
    [checkpoint('DONE'), checkpoint('DONE')],
    [event('step_update', {
      step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: 'After',
    }), result({ response: 'After' })],
  ])
  const driven = await driveFlow(g, flow())
  expect(steps(driven.events).map((s) => s.kind)).toEqual(['text', 'context', 'text'])
  expect(steps(driven.events)[1].context).toEqual({
    action: 'checkpoint', phase: 'completed', durationMs: 530,
  })
  const task = applyEvents(goldenInput(g).start, driven.events)
  expect(task.items).toEqual([
    expect.objectContaining({ kind: 'message', text: 'Before' }),
    expect.objectContaining({ kind: 'context', action: 'checkpoint', durationMs: 530 }),
    expect.objectContaining({ kind: 'message', text: 'After' }),
  ])
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
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'run_command',
      input: 'printf agy-golden',
      rule: 'command(printf agy-golden)',
    }),
    expect.objectContaining({ kind: 'tool_result', text: 'agy-golden' }),
    expect.objectContaining({ kind: 'text', text: 'Golden complete.\n' }),
  ]))
  expect(driven.events).toContainEqual(expect.objectContaining({ kind: 'update', finalText: 'Golden complete.\n' }))
  expect(driven.result.exitCode).toBe(0)
})

it('formats tool inputs, permission rules, file-edit diffs, subagent summaries, and truncated outputs', async () => {
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
    toolStep(11, 'read_url_content', { Url: 'https://antigravity.google/docs/cli' }),
    toolStep(12, 'call_mcp_tool', { ServerName: 'playwright', ToolName: 'browser_snapshot' }),
    toolStep(13, 'notebook_edit', { NotebookPath: '/repo/demo.ipynb' }),
    result(),
  ]])
  const driven = await driveFlow(g, flow())
  expect(steps(driven.events)).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'run_command',
      input: 'npm test npm run typecheck',
      inputFull: 'npm test\nnpm run typecheck',
      rule: 'command(npm test\nnpm run typecheck)',
    }),
    expect.objectContaining({
      kind: 'tool_result',
      text: 'line 1\nline 2\nline 3\n…',
    }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'view_file',
      input: '/repo/src/app.ts',
      rule: 'read_file(/repo/src/app.ts)',
    }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'list_dir',
      input: '/repo/src',
      rule: 'read_file(/repo/src)',
    }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'grep_search',
      input: 'makeFlow',
      rule: 'read_file(/repo/daemon)',
    }),
    expect.objectContaining({ kind: 'tool_use', tool: 'code_search', input: 'resolveLaunchDir' }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'find_by_name',
      input: '*.test.ts',
      rule: 'read_file(/repo)',
    }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'replace_file_content',
      input: '/repo/src/app.ts',
      rule: 'write_file(/repo/src/app.ts)',
      edits: [{ old: 'const x = 1', new: 'const x = 2' }],
    }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'multi_replace_file_content',
      input: '/repo/src/multi.ts',
      rule: 'write_file(/repo/src/multi.ts)',
      edits: [
        { old: 'a', new: 'b' },
        { old: 'c', new: 'd' },
      ],
    }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'write_to_file',
      input: '/repo/src/new.ts',
      rule: 'write_file(/repo/src/new.ts)',
    }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'invoke_subagent',
      input: 'research: Codebase Researcher',
      inputFull: 'research: Codebase Researcher\n\nInspect the flow reducer.',
    }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'read_url_content',
      input: 'https://antigravity.google/docs/cli',
      rule: 'read_url(antigravity.google)',
    }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'call_mcp_tool',
      rule: 'mcp(playwright:browser_snapshot)',
    }),
    expect.objectContaining({
      kind: 'tool_use',
      tool: 'notebook_edit',
      input: '/repo/demo.ipynb',
      rule: 'write_file(/repo/demo.ipynb)',
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
  ]], afterFirst.flowState as Record<string, unknown>)
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

it('passes --mode accept-edits, --project lander-<hash>, canonicalized --add-dir paths, and seeds command(lander)', async () => {
  const realFilesDir = path.join(geminiConfigDir, 'real-files')
  const symlinkFilesDir = path.join(geminiConfigDir, 'symlink-files')
  mkdirSync(realFilesDir, { recursive: true })
  symlinkSync(realFilesDir, symlinkFilesDir)

  const g = fixture([[result()]])
  g.start = { ...g.start, env: { LANDER_API: 'http://localhost', LANDER_TOKEN: 'secret', PATH: '/bin' } }
  g.input = {
    root: '/repo',
    cwd: '/repo/sub',
    filesDir: symlinkFilesDir,
    materialized: { filesDir: symlinkFilesDir, manifestBlock: 'Attachment manifest' },
  }
  const driven = await driveFlow(g, flow())
  const spawn = driven.spawns[0]
  const expectedProjectId = agyProjectId('/repo')
  expect(spawn).toMatchObject({
    command: 'agy',
    cwd: '/repo/sub',
    env: {
      LANDER_API: 'http://localhost',
      LANDER_TOKEN: 'secret',
      LANDER_FILES_DIR: symlinkFilesDir,
      LANDER_RUN: 'ride-1',
    },
  })
  expect(spawn.args).not.toContain('--dangerously-skip-permissions')
  expect(spawn.args).toEqual(expect.arrayContaining([
    '--output-format', 'stream-json',
    '--print-timeout', '0s',
    '--mode', 'accept-edits',
    '--project', expectedProjectId,
    '--add-dir', '/tmp',
    '--add-dir', symlinkFilesDir,
    '--add-dir', realpathSync(symlinkFilesDir),
  ]))
  expect(spawn.args[1]).toContain('Task task-1.')
  expect(spawn.args[1]).toContain(projectDocBlock('Project instructions'))
  expect(spawn.args[1]).toContain('Attachment manifest')
  expect(spawn.args.filter((arg) => arg === '/tmp')).toHaveLength(1)
  const logFile = spawn.args[spawn.args.indexOf('--log-file') + 1]
  expect(existsSync(path.dirname(logFile))).toBe(false)

  const projectConfig = JSON.parse(
    readFileSync(agyProjectFile('/repo', geminiConfigDir), 'utf8'),
  )
  expect(projectConfig).toEqual({
    id: expectedProjectId,
    name: 'repo',
    projectResources: {},
    permissionGrants: {
      permissionGrants: {
        allow: ['command(lander)'],
      },
      v2Migrated: true,
    },
  })
})

it('marks refused tool calls blocked from their denial error or agy\'s log, preserves earlier prose, and omits blank messages', async () => {
  const calls: { url: string; method: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
      })
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ status: 'wedged' }),
        text: async () => '{"status":"wedged"}',
      } as Response
    }),
  )
  try {
    const withProse = fixture([[
      init('conv-0'),
      event('step_update', {
        step_index: 1,
        step_type: 'agent_response',
        state: 'DONE',
        text_delta: 'Running the check now.',
      }),
      toolStep(2, 'run_command', { CommandLine: 'git status' }),
      event('step_update', {
        step_index: 3,
        step_type: 'agent_response',
        state: 'DONE',
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      event('step_update', {
        step_index: 4,
        step_type: 'tool',
        state: 'ACTIVE',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo unlisted-probe' } },
      }),
      event('step_update', {
        step_index: 4,
        step_type: 'tool',
        state: 'ERROR',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          error: { message: 'Action denied by user.' },
        },
      }),
      result({
        response: 'Running the check now.',
        denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
      }),
    ]])
    withProse.start = {
      ...withProse.start,
      env: {
        LANDER_API: 'http://api.test',
        LANDER_PROJECT: 'proj',
        LANDER_TASK: 'task-1',
        LANDER_TOKEN: 'tok',
      },
    }
    const drivenWithProse = await driveFlow(withProse, flow())
    const taskWithProse = applyEvents(goldenInput(withProse).start, drivenWithProse.events)
    const itemsWithProse = (taskWithProse.items ?? []) as (BlockedItem & { text?: string })[]
    expect(itemsWithProse.filter((it) => it.kind === 'message').map((it) => it.text)).toEqual([
      'Running the check now.',
    ])
    expect(blockedRequests(itemsWithProse)).toEqual([
      {
        key: 'command(echo unlisted-probe)',
        rule: 'command(echo unlisted-probe)',
        tool: 'run_command',
      },
    ])

    const turnItems = async (lines: string[], log?: string) => {
      const g = fixture([lines])
      g.start = { ...g.start, env: withProse.start?.env }
      const driven = await driveFlow(g, flow(undefined, log))
      return (applyEvents(goldenInput(g).start, driven.events).items ?? []) as (BlockedItem & { text?: string })[]
    }
    const notices = (items: (BlockedItem & { text?: string })[]) =>
      items.filter((it) => it.kind === 'notice').map((it) => it.text)
    const deniedCommand = result({
      response: '',
      denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
    })
    const silentGitPush = [
      init('conv-1'),
      toolStep(1, 'run_command', { CommandLine: 'git push' }),
      deniedCommand,
    ]

    const itemsLogged = await turnItems(silentGitPush, refusalLine('conv-1', 1))
    expect(itemsLogged.filter((it) => it.kind === 'message')).toEqual([])
    expect(blockedRequests(itemsLogged)).toEqual([
      {
        key: 'command(git push)',
        rule: 'command(git push)',
        tool: 'run_command',
      },
    ])

    const itemsUnlogged = await turnItems(silentGitPush)
    expect(notices(itemsUnlogged)).toEqual([
      'Antigravity denied a RunCommand call this turn without saying which one.',
    ])
    expect(blockedRequests(itemsUnlogged)).toEqual([])

    const itemsTwoSilent = await turnItems([
      init('conv-2'),
      toolStep(1, 'run_command', { CommandLine: 'rm -f probe.txt' }),
      toolStep(2, 'run_command', { CommandLine: 'git status' }),
      deniedCommand,
    ], refusalLine('conv-2', 1))
    expect(notices(itemsTwoSilent)).toEqual([])
    expect(blockedRequests(itemsTwoSilent)).toEqual([
      {
        key: 'command(rm -f probe.txt)',
        rule: 'command(rm -f probe.txt)',
        tool: 'run_command',
      },
    ])

    const itemsSubagent = await turnItems([
      init('conv-3'),
      toolStep(2, 'invoke_subagent', { Subagents: [{ TypeName: 'self', Role: 'Probe Runner' }] }),
      result({
        response: 'Waiting for the subagent.',
        denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
      }),
    ], refusalLine('sub-conv', 2))
    expect(notices(itemsSubagent)).toEqual([
      'Antigravity refused a RunCommand call in a subagent.',
    ])
    expect(blockedRequests(itemsSubagent)).toEqual([])

    const deniedBeforeLaterCommands = fixture([[
      init('conv-4'),
      ...[
        ['bun run test spec.ts', 'user denied permission to run command'],
        ['bun run typecheck'],
        ['bun run lint', 'context canceled'],
      ].map(([CommandLine, error], i) =>
        toolStep(i + 1, 'run_command', undefined, {
          ...(error ? { state: 'ERROR' } : {}),
          tool_info: { parameters: { CommandLine }, ...(error ? { error: { message: error } } : {}) },
        })),
      result({
        response: '',
        denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
      }),
    ]])
    deniedBeforeLaterCommands.start = { ...deniedBeforeLaterCommands.start, env: withProse.start.env }
    const drivenDenied = await driveFlow(deniedBeforeLaterCommands, flow())
    const taskDenied = applyEvents(goldenInput(deniedBeforeLaterCommands).start, drivenDenied.events)
    expect(blockedRequests((taskDenied.items ?? []) as BlockedItem[])).toEqual([
      {
        key: 'command(bun run test spec.ts)',
        rule: 'command(bun run test spec.ts)',
        tool: 'run_command',
      },
    ])
    expect(calls).toEqual([])
  } finally {
    vi.unstubAllGlobals()
  }
})

it('prompts the agent again with only what it can\'t see, for as long as agy keeps refusing', async () => {
  const calls: { url: string; method: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({}) } as Response
  }))
  try {
    const denied = (step: number, CommandLine: string, usage: object) => [
      init('conv-r'),
      toolStep(step, 'run_command', { CommandLine }),
      result({
        response: '',
        denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
        usage,
      }),
    ]
    const g = fixture([denied(1, 'git push', { input_tokens: 100, output_tokens: 10 })])
    g.start = { ...g.start, env: { LANDER_API: 'http://api.test', LANDER_PROJECT: 'proj', LANDER_TASK: 'task-1', LANDER_TOKEN: 'tok' } }
    g.later = [{
      chunks: [[
        event('step_update', { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: 'I need permission to push.' }),
        result({ response: 'I need permission to push.', usage: { input_tokens: 250, output_tokens: 30 } }),
      ]],
    }]
    const driven = await driveFlow(g, flow(undefined, refusalLine('conv-r', 1)))
    const message = '[lander] Antigravity ended your turn because it refused a call needing a permission the user has not granted.\n- Your run_command call `git push` was refused. Its result says it was canceled.'
    expect(driven.spawns).toHaveLength(2)
    expect(driven.spawns[1].args.slice(0, 2)).toEqual(['-p', message])
    expect(driven.spawns[1].args).toEqual(expect.arrayContaining(['--conversation', 'conv-r']))
    const task = applyEvents(goldenInput(g).start, driven.events)
    const items = (task.items ?? []) as { kind: string; text?: string }[]
    expect(items.map((it) => [it.kind, it.text])).toEqual([
      ['tool', undefined],
      ['reprompt', message],
      ['message', 'I need permission to push.'],
    ])
    expect(task).toMatchObject({ rides: [expect.objectContaining({ usage: expect.objectContaining({ input: 250, output: 30 }) })] })
    expect(calls).toEqual([])

    const persistent = fixture([denied(1, 'git push', {})])
    persistent.start = g.start
    persistent.later = [
      ...[2, 3, 4, 5].map((n) => ({ chunks: [denied(n * 2, 'git push', {})] })),
      { chunks: [[result({ response: 'I need permission to push.', usage: {} })]] },
    ]
    const drivenPersistent = await driveFlow(persistent, flow(undefined, refusalLine('conv-r', 1)))
    expect(drivenPersistent.spawns).toHaveLength(6)
    expect(calls).toEqual([])
  } finally {
    vi.unstubAllGlobals()
  }
})

it('records the installed agy version on the ride', async () => {
  const g = fixture([[init('conv-v'), result()]])
  const driven = await driveFlow(g, makeFlow({
    taskPromptTemplate: 'Task {{id}}.', readProjectDoc: () => undefined, geminiConfigDir,
    readCliVersion: async () => '1.4.6',
  }))
  expect(applyEvents(goldenInput(g).start, driven.events).rides).toEqual([expect.objectContaining({ cliVersion: '1.4.6' })])
})

it('states each kind of refusal the agent can\'t place for itself, and nothing about ones it saw', () => {
  expect(agyRepromptMessage([
    { in: 'turn', tool: 'run_command', input: 'echo seen', seen: true },
    { in: 'subagent', action: 'RunCommand', conversation: 'sub-1' },
    { in: 'unknown', action: 'WriteToFile' },
  ])).toBe([
    '[lander] Antigravity ended your turn because it refused 3 calls needing a permission the user has not granted.',
    '- A RunCommand call by your subagent (conversation sub-1) was refused. Antigravity stopped the subagent when it ended your turn.',
    '- Antigravity did not say which WriteToFile call it refused.',
  ].join('\n'))
})

it('persists project grants via onGrant into the same lander-<hash>.json used by onTurn across worktrees', async () => {
  const rootDir = path.join(geminiConfigDir, 'workspace')
  const worktreeDir = path.join(rootDir, '.worktrees', 'task-1')
  mkdirSync(worktreeDir, { recursive: true })

  await onGrant(undefined, {
    projectPath: rootDir,
    rule: 'command(echo unlisted-probe)',
    geminiConfigDir,
  })
  await onGrant(undefined, {
    projectPath: rootDir,
    rule: 'command(echo unlisted-probe)',
    geminiConfigDir,
  })

  const g = fixture([[result()]])
  g.input = { root: rootDir, cwd: worktreeDir, checkout: worktreeDir }
  const driven = await driveFlow(g, flow())
  const expectedProjectId = agyProjectId(rootDir)
  expect(driven.spawns[0].args).toEqual(
    expect.arrayContaining(['--project', expectedProjectId]),
  )

  const projectConfig = JSON.parse(
    readFileSync(agyProjectFile(rootDir, geminiConfigDir), 'utf8'),
  )
  expect(projectConfig).toEqual({
    id: expectedProjectId,
    name: 'workspace',
    projectResources: {},
    permissionGrants: {
      permissionGrants: {
        allow: ['command(lander)', 'command(echo unlisted-probe)'],
      },
      v2Migrated: true,
    },
  })
})

it('resumes without redelivering unchanged instructions and redelivers changed documents', async () => {
  const first = await driveFlow(fixture([[init('conversation-1'), result()]]), flow())
  const afterFirst = applyEvents(goldenInput(fixture()).start, first.events)
  const g = fixture([[result()]], afterFirst.flowState as Record<string, unknown>)
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

it('emits intermediate text, terminal tool errors, and does not duplicate concatenated result.response', async () => {
  const g = fixture([[
    event('step_update', { step_index: 1, step_type: 'agent_response', text_delta: 'Checking' }),
    event('step_update', { step_index: 1, step_type: 'agent_response', text_delta: ' now' }),
    event('step_update', { step_index: 2, step_type: 'tool', state: 'ERROR', tool_info: { name: 'run_command', error: { message: 'Command failed' } } }),
    event('step_update', { step_index: 3, step_type: 'agent_response', text_delta: 'Finished' }),
    result({ response: 'Checking nowFinished' }),
  ]])
  const driven = await driveFlow(g, flow())
  expect(steps(driven.events).filter((step) => step.kind === 'text').map((step) => step.text)).toEqual(['Checking now', 'Finished'])
  expect(steps(driven.events)).toContainEqual(expect.objectContaining({ kind: 'tool_result', isError: true, text: 'Command failed' }))
  expect(driven.events).toContainEqual(expect.objectContaining({ kind: 'update', finalText: 'Finished' }))
})

it('normalizes glob-style command rules in normalizeAgyRule and onGrant', async () => {
  expect(normalizeAgyRule('command(git *)')).toBe('command(git)')
  expect(normalizeAgyRule('command(git:*)')).toBe('command(git)')
  expect(normalizeAgyRule('command(npm test *)')).toBe('command(npm test)')
  expect(normalizeAgyRule('command(*)')).toBe('command(*)')
  expect(normalizeAgyRule('write_file(/tmp/*)')).toBe('write_file(/tmp/*)')

  const rootDir = path.join(geminiConfigDir, 'workspace-glob')
  mkdirSync(rootDir, { recursive: true })
  await onGrant(undefined, {
    projectPath: rootDir,
    rule: 'command(git *)',
    geminiConfigDir,
  })
  await onGrant(undefined, {
    projectPath: rootDir,
    rule: 'command(git:*)',
    geminiConfigDir,
  })
  const projectConfig = JSON.parse(
    readFileSync(agyProjectFile(rootDir, geminiConfigDir), 'utf8'),
  )
  expect(projectConfig.permissionGrants.permissionGrants.allow).toEqual([
    'command(lander)',
    'command(git)',
  ])
})

