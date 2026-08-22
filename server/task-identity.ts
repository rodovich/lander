// Task ids are both URL segments and JSON filename stems. Keep the grammar and
// the project-qualified in-memory key in one place so routing, locking and run
// guards cannot silently disagree.
export const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/

export function taskKey(projectSlug: string, id: string): string {
  return JSON.stringify([projectSlug, id])
}
