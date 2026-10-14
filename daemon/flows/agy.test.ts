import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { makeFlow, meta, resolveLaunchDir } from './agy'
import { announcedFlows, buildFlows, providerCaps } from './index'
import { driveFlow, goldenInput, type Golden } from './testCtx'
import { applyEvents } from './testTask'
import { deliveryDigest, projectDocBlock } from 'lander/flow'

const flow = (doc: string | undefined = 'Project instructions') => makeFlow({
  taskPromptTemplate: 'Task {{id}}. {{forwardable}}',
  readProjectDoc: () => doc,
})
const fixture = (chunks: string[][] = []): Golden => ({
  name: 'agy', chunks,
  start: { flow: 'agy', task: { allowEdits: true } },
})
const event = (name: string, data: object) => JSON.stringify({ event: name, [name]: data })
const result = (data: object = {}) => event('result', { status: 'SUCCESS', response: 'Done', ...data })
const patches = (events: Awaited<ReturnType<typeof driveFlow>>['events']) =>
  events.flatMap((e) => e.kind === 'state-patch' ? e.ops : [])

it('registers an executable driver and its capabilities', () => {
  expect(announcedFlows()).toContainEqual({ scope: 'bundled', meta })
  expect(providerCaps().agy).toMatchObject({ visionNative: false, projectGrants: false, usageSnapshot: false })
  expect(buildFlows({ root: process.cwd(), env: {} }).agy.meta).toEqual(meta)
  expect(resolveLaunchDir({ root: '/repo', recordedCwd: '/repo/sub', isDir: () => true })).toEqual({ cwd: '/repo/sub' })
  expect(resolveLaunchDir({ root: '/repo', recordedCwd: '/gone', isDir: () => false })).toEqual({ cwd: '/repo' })
})

it('rejects read-only turns before spawning or changing state', async () => {
  const g = fixture()
  g.start!.task = { allowEdits: false }
  const driven = await driveFlow(g, flow())
  expect(driven.spawns).toEqual([])
  expect(patches(driven.events)).toEqual([])
  expect(driven.result).toMatchObject({ exitCode: 1, stderr: expect.stringContaining('--edits') })
})

it('reduces the recorded Antigravity stream into a session, tool lifecycle, and reply', async () => {
  const lines = readFileSync(new URL('./fixtures/agy.jsonl', import.meta.url), 'utf8').trim().split('\n')
  const g = fixture([lines])
  const driven = await driveFlow(g, flow())
  const task = applyEvents(goldenInput(g).start, driven.events)
  expect(task).toMatchObject({ flowState: { sessionId: JSON.parse(lines[0]).conversation_id } })
  const steps = driven.events.flatMap((e) => e.kind === 'update' ? e.steps ?? [] : [])
  expect(steps).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'tool_use', tool: 'run_command', input: JSON.stringify({ CommandLine: 'printf agy-golden' }) }),
    expect.objectContaining({ kind: 'tool_result', text: expect.stringContaining('agy-golden') }),
    expect.objectContaining({ kind: 'text', text: 'Golden complete.\n' }),
  ]))
  expect(driven.events).toContainEqual(expect.objectContaining({ kind: 'update', finalText: 'Golden complete.\n' }))
  expect(driven.result.exitCode).toBe(0)
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
  const steps = driven.events.flatMap((e) => e.kind === 'update' ? e.steps ?? [] : [])
  expect(steps.filter((step) => step.kind === 'text').map((step) => step.text)).toEqual(['Checking now', 'Finished'])
  expect(steps).toContainEqual(expect.objectContaining({ kind: 'tool_result', isError: true, text: 'Command failed' }))
  expect(driven.events).toContainEqual(expect.objectContaining({ kind: 'update', finalText: 'Finished' }))
})
