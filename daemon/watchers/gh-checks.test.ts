import { describe, expect, it } from 'vitest'
import ghChecks from './gh-checks'
import type { GitHub } from './github'
import { PermanentWatcherError } from './types'

type World = {
  head: string
  runs: Record<string, { name: string; status: string; conclusion: string | null }[]>
  statuses?: Record<string, { context: string; state: string }[]>
}

function github(world: World): GitHub {
  return {
    async get(path) {
      if (path === '/repos/o/r/pulls/7') return { body: { head: { sha: world.head } } }
      const runs = path.match(/^\/repos\/o\/r\/commits\/(\w+)\/check-runs/)
      if (runs)
        return {
          body: {
            check_runs: (world.runs[runs[1]] ?? []).map((r) => ({
              ...r,
              html_url: `https://ci/${r.name}`,
            })),
          },
        }
      const status = path.match(/^\/repos\/o\/r\/commits\/(\w+)\/status\?/)
      if (status)
        return {
          body: {
            statuses: (world.statuses?.[status[1]] ?? []).map((s) => ({ ...s, target_url: null })),
          },
        }
      throw new Error(`unexpected ${path}`)
    },
  }
}

function run(world: World, prev?: unknown, args: Record<string, string> = { pr: 'o/r#7' }) {
  return ghChecks.run(
    { cwd: '/repo', signal: new AbortController().signal, github: github(world) },
    args,
    prev,
  )
}

const running = (name: string) => ({ name, status: 'in_progress', conclusion: null })
const passed = (name: string) => ({ name, status: 'completed', conclusion: 'success' })
const failed = (name: string) => ({ name, status: 'completed', conclusion: 'failure' })

describe('gh-checks', () => {
  it('waits while checks run, then reports that all passed', async () => {
    const world: World = { head: 'abc1234def', runs: { abc1234def: [passed('lint'), running('test')] } }
    const first = await run(world)
    expect(first.fired).toBe(false)
    world.runs.abc1234def = [passed('lint'), passed('test')]
    const finished = await run(world, first.state)
    expect(finished.fired).toBe(false)
    expect(await run(world, finished.state)).toMatchObject({
      fired: true,
      message: 'All 2 checks passed on abc1234 in o/r.\nSee them with `gh pr checks 7 --repo o/r`.',
    })
  })

  it('does not report a pass while more checks are still registering', async () => {
    const world: World = { head: 'abc1234def', runs: { abc1234def: [passed('labeler')] } }
    const first = await run(world)
    expect(first.fired).toBe(false)
    world.runs.abc1234def = [passed('labeler'), running('test')]
    expect((await run(world, first.state)).fired).toBe(false)
  })

  it('counts a conclusion it does not recognize as a failure', async () => {
    const world: World = {
      head: 'abc1234def',
      runs: { abc1234def: [{ name: 'test', status: 'completed', conclusion: 'stale' }] },
    }
    expect(await run(world)).toMatchObject({
      fired: true,
      message: expect.stringContaining('1 of 1 checks failed'),
    })
  })

  it('reports the failures once every check has finished', async () => {
    const world: World = {
      head: 'abc1234def',
      runs: { abc1234def: [failed('test'), running('build')] },
      statuses: { abc1234def: [{ context: 'deploy-preview', state: 'success' }] },
    }
    expect((await run(world)).fired).toBe(false)
    world.runs.abc1234def = [failed('test'), passed('build')]
    expect(await run(world)).toMatchObject({
      fired: true,
      message: expect.stringContaining('1 of 3 checks failed on abc1234 in o/r:\n- test: https://ci/test'),
    })
  })

  it('fires at the first failure with fail-fast', async () => {
    const world: World = { head: 'abc1234def', runs: { abc1234def: [failed('test'), running('build')] } }
    expect(await run(world, undefined, { pr: 'o/r#7', 'fail-fast': 'true' })).toMatchObject({
      fired: true,
      message: expect.stringContaining('(1 still running)'),
    })
  })

  it('follows the PR to a new head', async () => {
    const world: World = {
      head: 'abc1234def',
      runs: { abc1234def: [running('test')], fff9999aaa: [passed('test')] },
    }
    const first = await run(world)
    world.head = 'fff9999aaa'
    const moved = await run(world, first.state)
    expect(moved.fired).toBe(false)
    expect(await run(world, moved.state)).toMatchObject({
      fired: true,
      message: expect.stringContaining('on fff9999'),
    })
  })

  it('watches one commit given repo and sha', async () => {
    const world: World = { head: 'unused', runs: { abc1234def: [passed('test')] } }
    const args = { repo: 'o/r', sha: 'abc1234def' }
    const first = await run(world, undefined, args)
    expect(await run(world, first.state, args)).toMatchObject({
      fired: true,
      message: 'The only check passed on abc1234 in o/r.',
    })
  })

  it('says so when no check reports for half an hour', async () => {
    const world: World = { head: 'abc1234def', runs: {} }
    let state: unknown
    for (let i = 0; i < 5; i++) {
      const r = await run(world, state)
      expect(r.fired).toBe(false)
      state = r.state
    }
    const fired = await run(world, state)
    expect(fired).toMatchObject({
      fired: true,
      message: expect.stringContaining('No checks have reported on abc1234'),
    })
    expect((await run(world, fired.state)).fired).toBe(false)
  })

  it('refuses arguments that name nothing to watch', async () => {
    const world: World = { head: 'x', runs: {} }
    await expect(run(world, undefined, {})).rejects.toBeInstanceOf(PermanentWatcherError)
    await expect(run(world, undefined, { pr: 'nope' })).rejects.toBeInstanceOf(PermanentWatcherError)
    await expect(run(world, undefined, { repo: 'o/r', sha: 'main' })).rejects.toBeInstanceOf(PermanentWatcherError)
    await expect(run(world, undefined, { pr: 'o/r#7', 'fail-fast': 'yes' })).rejects.toBeInstanceOf(PermanentWatcherError)
  })
})
