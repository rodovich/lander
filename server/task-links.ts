import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Project } from './projects'
import { publicTaskStatus, type Ride } from './tasks'
import { TASK_ID } from './task-identity'

export type TaskLink = {
  id: string
  projectSlug: string
  title: string
  status: string
  archived: boolean
}

type LinkTask = {
  id?: unknown
  title?: unknown
  status?: unknown
  rides?: Ride[]
  runId?: unknown
}
type Overlay = { link: TaskLink; clearBothPools: boolean }
type Pools = Map<boolean, TaskLink>

const pairKey = (projectSlug: string, id: string) =>
  JSON.stringify([projectSlug, id])

function sameLink(a: TaskLink | undefined, b: TaskLink): boolean {
  return !!a &&
    a.id === b.id &&
    a.projectSlug === b.projectSlug &&
    a.title === b.title &&
    a.status === b.status &&
    a.archived === b.archived
}

function projectTask(task: LinkTask, projectSlug: string, id: string, archived: boolean): TaskLink {
  if (!TASK_ID.test(id)) throw new Error(`invalid task filename id: ${id}`)
  if (task.id !== undefined && task.id !== id)
    throw new Error(`task id does not match filename: ${String(task.id)} != ${id}`)
  if (typeof task.title !== 'string') throw new Error(`task ${id} has no title`)
  const status = publicTaskStatus(task as LinkTask & { status?: string })
  if (!status) throw new Error(`task ${id} has no status`)
  return { id, projectSlug, title: task.title, status, archived }
}

async function readPool(
  project: Project,
  dir: string,
  archived: boolean,
): Promise<TaskLink[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const links: TaskLink[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -5)
    let raw: string
    try {
      raw = await readFile(path.join(dir, name), 'utf8')
    } catch (error) {
      // A Lander-owned archive/restore may move a listed source. Its full move
      // overlay is authoritative and will seed the destination before publish.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    links.push(projectTask(JSON.parse(raw) as LinkTask, project.slug, id, archived))
  }
  return links
}

export class TaskLinkIndex {
  private readonly epoch = randomUUID()
  private revision = 0
  private links: Map<string, TaskLink> | null = null
  private boot: Promise<void> | null = null
  private overlay: Map<string, Overlay> | null = null
  private dirtyGeneration = 0

  constructor(private readonly projects: Project[]) {}

  markDirty(): void {
    this.dirtyGeneration++
    this.links = null
  }

  observeWrite(file: string, value: unknown): void {
    try {
      const target = this.targetFor(file)
      if (!target) return
      const link = projectTask(
        value as LinkTask,
        target.project.slug,
        target.id,
        target.archived,
      )
      this.upsert(link, false)
    } catch (error) {
      console.error('task-link index write projection failed:', error)
      this.markDirty()
    }
  }

  observeMove(project: Project, id: string, task: unknown, archived: boolean): void {
    try {
      this.upsert(projectTask(task as LinkTask, project.slug, id, archived), true)
    } catch (error) {
      console.error('task-link index move projection failed:', error)
      this.markDirty()
    }
  }

  async snapshot(): Promise<{ links: TaskLink[]; etag: string }> {
    await this.ensureReady()
    const links = [...this.links!.values()].sort((a, b) =>
      a.projectSlug.localeCompare(b.projectSlug) || a.id.localeCompare(b.id),
    )
    return { links, etag: `"${this.epoch}-${this.revision}"` }
  }

  async linksForId(id: string): Promise<TaskLink[]> {
    await this.ensureReady()
    return [...this.links!.values()].filter((link) => link.id === id)
  }

  async ensureReady(): Promise<void> {
    if (this.links) return
    if (this.boot) return this.boot
    const generation = this.dirtyGeneration
    this.overlay = new Map()
    const run = this.bootstrap(generation)
    this.boot = run
    try {
      await run
    } finally {
      if (this.boot === run) this.boot = null
    }
  }

  private async bootstrap(generation: number): Promise<void> {
    const base = new Map<string, Pools>()
    for (const project of this.projects) {
      // Archive first, active second, matching the single-task endpoint's active
      // precedence if an unsupported out-of-band duplicate exists. We still fail
      // unresolved duplicates below.
      for (const [dir, archived] of [
        [project.archiveDir, true],
        [project.dataDir, false],
      ] as const) {
        for (const link of await readPool(project, dir, archived)) {
          const key = pairKey(link.projectSlug, link.id)
          const pools = base.get(key) ?? new Map<boolean, TaskLink>()
          pools.set(archived, link)
          base.set(key, pools)
        }
      }
    }
    if (generation !== this.dirtyGeneration)
      throw new Error('task-link index changed during bootstrap')
    for (const [key, event] of this.overlay ?? []) {
      const pools = base.get(key) ?? new Map<boolean, TaskLink>()
      if (event.clearBothPools) pools.clear()
      pools.set(event.link.archived, event.link)
      base.set(key, pools)
    }
    const next = new Map<string, TaskLink>()
    for (const [key, pools] of base) {
      if (pools.size !== 1)
        throw new Error(`task exists in both active and archive pools: ${key}`)
      next.set(key, [...pools.values()][0])
    }
    if (generation !== this.dirtyGeneration)
      throw new Error('task-link index invalidated during bootstrap')
    this.links = next
    this.overlay = null
    this.revision++
  }

  private upsert(link: TaskLink, clearBothPools: boolean): void {
    const key = pairKey(link.projectSlug, link.id)
    if (this.overlay) {
      const prior = this.overlay.get(key)
      this.overlay.set(key, {
        link,
        clearBothPools: clearBothPools || prior?.clearBothPools === true,
      })
      return
    }
    if (!this.links) return // Durable disk is the source for a later cold scan.
    const prior = this.links.get(key)
    if (sameLink(prior, link)) return
    this.links.set(key, link)
    this.revision++
  }

  private targetFor(file: string): {
    project: Project
    id: string
    archived: boolean
  } | null {
    const dir = path.dirname(file)
    const name = path.basename(file)
    if (!name.endsWith('.json')) return null
    for (const project of this.projects) {
      if (dir === project.dataDir)
        return { project, id: name.slice(0, -5), archived: false }
      if (dir === project.archiveDir)
        return { project, id: name.slice(0, -5), archived: true }
    }
    return null
  }
}

export function etagMatches(header: string | undefined, current: string): boolean {
  if (!header) return false
  const bare = (value: string) => value.trim().replace(/^W\//, '')
  return header.split(',').some((value) => value.trim() === '*' || bare(value) === current)
}
