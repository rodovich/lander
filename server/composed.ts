import { randomBytes } from 'node:crypto'

// Messages a task has composed with `lander compose`, for `launch` and `send` to
// fetch by id. One lost to a server restart is composed again.
const TTL_MS = 24 * 60 * 60 * 1000

type Draft = { message: string; at: number }

export function createComposedStore(now: () => number = Date.now) {
  const drafts = new Map<string, Draft>()
  const key = (project: string, task: string, id: string) =>
    `${project}\0${task}\0${id}`

  function prune() {
    const cutoff = now() - TTL_MS
    for (const [k, d] of drafts) if (d.at < cutoff) drafts.delete(k)
  }

  return {
    put(project: string, task: string, message: string): string {
      prune()
      const id = randomBytes(6).toString('base64url')
      drafts.set(key(project, task, id), { message, at: now() })
      return id
    },
    get(project: string, task: string, id: string): string | undefined {
      prune()
      return drafts.get(key(project, task, id))?.message
    },
  }
}
