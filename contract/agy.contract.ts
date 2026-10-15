import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runAssist } from '../daemon/assist'
import { agyProjectFile, makeFlow, onGrant } from '../daemon/flows/agy'
import { blockedRequests, type BlockedItem } from '../src/permissions'
import {
  TASK_PROMPT,
  cliVersion,
  driveLive,
  replyText,
  scratchDir,
} from './live'

const VERSION = cliVersion('agy')

describe.skipIf(!VERSION)(`agy contract (${VERSION})`, () => {
  const flow = makeFlow({
    taskPromptTemplate: TASK_PROMPT,
    readProjectDoc: () => undefined,
  })

  let origPath: string | undefined
  let stubDir: string | undefined
  const roots: string[] = []

  const testRoot = (): string => {
    const dir = scratchDir({ git: true })
    roots.push(dir)
    return dir
  }

  beforeAll(() => {
    origPath = process.env.PATH
    stubDir = scratchDir({ git: false })
    const bin = path.join(stubDir, 'lander')
    writeFileSync(bin, '#!/bin/sh\necho lander-contract-ok\n')
    chmodSync(bin, 0o755)
    process.env.PATH = `${stubDir}${path.delimiter}${origPath ?? ''}`
  })

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(agyProjectFile(root), { force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  afterAll(() => {
    process.env.PATH = origPath
    if (stubDir) rmSync(stubDir, { recursive: true, force: true })
  })

  it('allows command(lander) and workspace file edits under --mode accept-edits and --project', async () => {
    const root = testRoot()
    const file = path.join(root, 'probe.txt')
    const turn = await driveLive(flow, {
      root,
      prompt: [
        `1. Call write_to_file to create ${file} with CodeContent "agy-edit-ok".`,
        '2. Call run_command with CommandLine "lander help".',
        '3. Reply with "done". Do not call any other tools.',
      ].join('\n'),
    })

    expect(turn.result.exitCode).toBe(0)
    expect(readFileSync(file, 'utf8')).toContain('agy-edit-ok')
    const items = (turn.task.items ?? []) as (BlockedItem & {
      output?: string
    })[]
    expect(blockedRequests(items)).toEqual([])
    const landerCall = items.find(
      (it) => it.kind === 'tool' && it.name === 'run_command',
    )
    expect(landerCall).toMatchObject({
      status: 'ok',
      rule: 'command(lander help)',
    })
    expect(landerCall?.output).toContain('lander-contract-ok')
  })

  it('marks an unlisted command blocked and allows it on resume after onGrant', async () => {
    const root = testRoot()
    const refused = await driveLive(flow, {
      root,
      prompt:
        'Call run_command once with CommandLine "echo unlisted-probe" and nothing else.',
    })

    const sessionId = refused.task.flowState?.sessionId
    expect(typeof sessionId).toBe('string')
    const refusedItems = (refused.task.items ?? []) as BlockedItem[]
    const blocked = blockedRequests(refusedItems)
    expect(blocked).toEqual([
      {
        key: 'command(echo unlisted-probe)',
        rule: 'command(echo unlisted-probe)',
        tool: 'run_command',
      },
    ])

    await onGrant(undefined, {
      projectPath: root,
      rule: blocked[0].rule,
    })

    const granted = await driveLive(flow, {
      root,
      prior: refused.task,
      prompt:
        'Call run_command once with CommandLine "echo unlisted-probe" and reply with its output.',
    })

    expect(granted.result.exitCode).toBe(0)
    expect(granted.task.flowState?.sessionId).toBe(sessionId)
    const secondRideId = granted.ride.id
    const secondRideItems = (
      (granted.task.items ?? []) as (BlockedItem & {
        rideId?: string
        output?: string
      })[]
    ).filter((it) => it.rideId === secondRideId)
    expect(blockedRequests(secondRideItems)).toEqual([])
    expect(replyText(granted)).toContain('unlisted-probe')
  })

  it('clamps runAssist so an agy one-shot cannot modify the target checkout', async () => {
    const root = testRoot()
    const targetFile = path.join(root, 'protected.txt')
    writeFileSync(targetFile, 'intact\n')

    await runAssist({
      provider: 'agy',
      cwd: root,
      prompt: `Call write_to_file to overwrite ${targetFile} with "destroyed", or if denied reply with "denied".`,
    })

    expect(readFileSync(targetFile, 'utf8')).toBe('intact\n')
  })
})

