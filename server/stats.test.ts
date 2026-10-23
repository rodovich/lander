import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { projectRecord, readStats } from './stats'
import type { Project } from './projects'

describe('projectRecord', () => {
  it('takes the first launch, every landing, and each ride', () => {
    const p = projectRecord('proj', {
      agent: 'codex',
      items: [
        { id: '1', kind: 'event', eventKind: 'scheduled', at: 'T0' },
        { id: '2', kind: 'event', eventKind: 'launched', at: 'T1' },
        { id: '3', kind: 'event', eventKind: 'landed', at: 'T2' },
        { id: '4', kind: 'event', eventKind: 'launched', at: 'T3' },
        { id: '5', kind: 'event', eventKind: 'landed', at: 'T4' },
      ],
      rides: [
        {
          id: 'r1',
          startedAt: 'S1',
          durationMs: 5,
          usage: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, model: 'm', costUsd: 0.5 },
        },
        { id: 'r2', startedAt: 'S2' },
      ],
    } as never)
    expect(p.task).toEqual({ project: 'proj', flow: 'codex', launchedAt: 'T1', landedAt: ['T2', 'T4'] })
    expect(p.turns).toEqual([
      { project: 'proj', flow: 'codex', startedAt: 'S1', model: 'm', durationMs: 5, costUsd: 0.5 },
      { project: 'proj', flow: 'codex', startedAt: 'S2' },
    ])
  })

  it('credits each ride to the flow that ran it', () => {
    const p = projectRecord('proj', {
      flow: 'codex',
      rides: [
        { id: 'r1', startedAt: 'S1', flow: 'claude' },
        { id: 'r2', startedAt: 'S2', flow: 'codex' },
      ],
    })
    expect(p.turns.map((t) => t.flow)).toEqual(['claude', 'codex'])
  })
})

describe('readStats', () => {
  it('reads both pools of every project and follows a file that changes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stats-'))
    const project = {
      slug: 'proj',
      dataDir: path.join(root, 'tasks'),
      archiveDir: path.join(root, 'archived'),
    } as Project
    await mkdir(project.dataDir)
    await mkdir(project.archiveDir)
    const task = (flow: string) =>
      JSON.stringify({ flow, items: [], rides: [{ id: 'r', startedAt: 'S' }] })
    await writeFile(path.join(project.dataDir, 'a.json'), task('claude'))
    await writeFile(path.join(project.archiveDir, 'b.json'), task('codex'))
    await writeFile(path.join(project.dataDir, 'c.json.x.tmp'), 'partial')

    const first = await readStats([project])
    expect(first.tasks.map((t) => t.flow).sort()).toEqual(['claude', 'codex'])
    expect(first.turns).toHaveLength(2)

    const file = path.join(project.dataDir, 'a.json')
    await writeFile(file, task('other-flow') + ' ')
    await utimes(file, new Date(), new Date(Date.now() + 5000))
    const second = await readStats([project])
    expect(second.tasks.map((t) => t.flow).sort()).toEqual(['codex', 'other-flow'])
  })
})
