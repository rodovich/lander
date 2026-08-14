import type { FlowMeta, Task, TaskWithProject, TelemetryItem } from './types'

// The per-flow status telemetry map (agent → items) the tasks poll carries. Global,
// so every project's response repeats it; an agent with no items is simply absent.
export type FlowTelemetry = Record<string, TelemetryItem[]>

// Request headers that mark a call as coming from the human's browser. The
// server gates permission-granting endpoints (creating a task with edit/commit
// access, toggling those grants, allowing a tool) on this token so a task can't
// hit the same API to escalate itself. dev.mjs hands the value to both Vite
// (here) and the API server. JSON content-type rides along since every caller
// that needs the token also sends a JSON body.
export const uiHeaders = (): Record<string, string> => {
  const token = import.meta.env.VITE_LANDER_UI_TOKEN
  return {
    'content-type': 'application/json',
    ...(token ? { 'x-lander-ui-token': token } : {}),
  }
}

// Upload attachments to a project's durable store, returning their ids to thread
// into a task-create / message POST. Multipart, so we send only the UI token
// header (the browser sets the multipart content-type + boundary itself).
export async function uploadAttachments(
  slug: string,
  files: File[],
): Promise<string[]> {
  if (!files.length) return []
  const token = import.meta.env.VITE_LANDER_UI_TOKEN
  const fd = new FormData()
  for (const f of files) fd.append('file', f)
  const r = await fetch(`/api/${slug}/attachments`, {
    method: 'POST',
    headers: token ? { 'x-lander-ui-token': token } : {},
    body: fd,
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? r.statusText)
  return (body.attachments ?? []).map((a: { id: string }) => a.id)
}

// The driver flows a project can launch a task with, for the new-task picker.
// Everything served here is dispatchable — the server unions what the daemon
// announced with the legacy flows — so a picked flow can't wedge on its first
// message. Returns [] on any failure; the caller falls back to its current
// options rather than rendering an empty picker.
export async function loadFlows(slug: string): Promise<FlowMeta[]> {
  try {
    const r = await fetch(`/api/${slug}/flows`)
    const body = await r.json()
    if (!r.ok) return []
    return (body.flows ?? []) as FlowMeta[]
  } catch {
    return []
  }
}

// Fetch and merge tasks across every shown project, tagging each with its
// project slug and sorting the combined list by recency.
// `summary` asks the server for the metadata-only projection (see taskSummary):
// the tasks come back without `items`/`rides`, which is the whole conversation
// and ~99% of the bytes. Only for callers that read metadata alone — the
// displayed list reads the conversation on every row.
export async function loadShownTasks(
  slugs: string[],
  includeArchived: boolean,
  opts?: { summary?: boolean },
): Promise<{ tasks: TaskWithProject[]; telemetry: FlowTelemetry }> {
  const query = [includeArchived ? 'archived=1' : '', opts?.summary ? 'view=summary' : '']
    .filter(Boolean)
    .join('&')
  const lists = await Promise.all(
    slugs.map(async (slug) => {
      const r = await fetch(`/api/${slug}/tasks${query ? `?${query}` : ''}`)
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      return {
        tasks: (body.tasks as Task[]).map((t) => ({ ...t, projectSlug: slug })),
        telemetry: (body.telemetry ?? {}) as FlowTelemetry,
      }
    }),
  )
  const merged = lists.flatMap((l) => l.tasks)
  merged.sort((a, b) =>
    (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
  )
  // Telemetry is global — every project's response carries the same map, so take
  // the first one that has any items.
  const telemetry =
    lists.map((l) => l.telemetry).find((t) => Object.keys(t).length > 0) ?? {}
  return { tasks: merged, telemetry }
}
