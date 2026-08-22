import type { TaskLink, TaskWithProject } from './types'

export type TaskRef = { projectSlug: string; id: string }

export function taskKey(projectSlug: string, id: string): string {
  return `${projectSlug}/${id}`
}

export function taskKeyOf(task: TaskWithProject): string {
  return taskKey(task.projectSlug, task.id)
}

export function taskRefFromPath(pathname = window.location.pathname): TaskRef | null {
  const parts = pathname.split('/').filter(Boolean)
  return parts.length === 2 ? { projectSlug: parts[0], id: parts[1] } : null
}

export function taskHref(projectSlug: string, id: string): string {
  return `/${projectSlug}/${id}`
}

export function migrateLegacyTaskValues<T>(
  values: Record<string, T>,
  links: TaskLink[],
): Record<string, T> {
  const uniqueProject = new Map<string, string | null>()
  for (const link of links) {
    const prior = uniqueProject.get(link.id)
    uniqueProject.set(
      link.id,
      prior === undefined
        ? link.projectSlug
        : prior === link.projectSlug
          ? prior
          : null,
    )
  }
  let next = values
  for (const [legacyId, value] of Object.entries(values)) {
    if (legacyId.includes('/')) continue
    const projectSlug = uniqueProject.get(legacyId)
    if (!projectSlug) continue
    if (next === values) next = { ...values }
    const qualified = taskKey(projectSlug, legacyId)
    if (next[qualified] === undefined) next[qualified] = value
    delete next[legacyId]
  }
  return next
}
