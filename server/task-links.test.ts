import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Project } from './projects'
import { TaskLinkIndex, etagMatches } from './task-links'

let root: string
let project: Project

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'lander-task-links-'))
  project = {
    path: root,
    slug: 'one',
    dataDir: path.join(root, 'tasks'),
    archiveDir: path.join(root, 'archived'),
    runsDir: path.join(root, 'runs'),
    flowsDir: path.join(root, 'flows'),
    attachmentsDir: path.join(root, 'attachments'),
    hooksFile: path.join(root, 'hooks.json'),
  }
  await Promise.all([
    mkdir(project.dataDir, { recursive: true }),
    mkdir(project.archiveDir, { recursive: true }),
  ])
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const write = (dir: string, id: string, task: Record<string, unknown>) =>
  writeFile(path.join(dir, `${id}.json`), JSON.stringify({ id, ...task }))

describe('TaskLinkIndex', () => {
  it('scans all pools once and serves the compact public status', async () => {
    await write(project.dataDir, 'active', {
      title: 'Active',
      status: 'riding',
      rides: [],
    })
    await write(project.archiveDir, 'old', {
      title: 'Old',
      status: 'landed',
      rides: [],
    })
    const snapshot = await new TaskLinkIndex([project]).snapshot()
    expect(snapshot.links).toEqual([
      {
        id: 'active',
        projectSlug: 'one',
        title: 'Active',
        status: 'resting',
        archived: false,
      },
      {
        id: 'old',
        projectSlug: 'one',
        title: 'Old',
        status: 'landed',
        archived: true,
      },
    ])
  })

  it('updates warm snapshots in memory and leaves the ETag stable for no-ops', async () => {
    await write(project.dataDir, 'task', {
      title: 'First',
      status: 'riding',
      rides: [],
    })
    const index = new TaskLinkIndex([project])
    const first = await index.snapshot()
    index.observeWrite(path.join(project.dataDir, 'task.json'), {
      id: 'task',
      title: 'Second',
      status: 'riding',
      rides: [],
    })
    const second = await index.snapshot()
    expect(second.links[0].title).toBe('Second')
    expect(second.etag).not.toBe(first.etag)
    index.observeWrite(path.join(project.dataDir, 'task.json'), {
      id: 'task',
      title: 'Second',
      status: 'riding',
      rides: [],
    })
    expect((await index.snapshot()).etag).toBe(second.etag)
  })

  it('moves a link between pools as one projection update', async () => {
    await write(project.dataDir, 'task', {
      title: 'Task',
      status: 'landed',
      rides: [],
    })
    const index = new TaskLinkIndex([project])
    await index.snapshot()
    index.observeMove(
      project,
      'task',
      { id: 'task', title: 'Task', status: 'landed', rides: [] },
      true,
    )
    expect((await index.snapshot()).links[0].archived).toBe(true)
  })

  it('fails closed on filename/body identity mismatches', async () => {
    await writeFile(
      path.join(project.dataDir, 'wanted.json'),
      JSON.stringify({ id: 'other', title: 'Wrong', status: 'landed' }),
    )
    await expect(new TaskLinkIndex([project]).snapshot()).rejects.toThrow(
      'does not match filename',
    )
  })
})

describe('etagMatches', () => {
  it('accepts weak validators and comma-separated lists', () => {
    expect(etagMatches('"old", W/"epoch-3"', '"epoch-3"')).toBe(true)
    expect(etagMatches('*', '"epoch-3"')).toBe(true)
    expect(etagMatches('"epoch-2"', '"epoch-3"')).toBe(false)
  })
})
