import type {
  FlowMeta,
  ProjectHooks,
  Task,
  TaskLink,
  TaskWithProject,
  TelemetryItem,
} from './types'

// The per-flow status telemetry map (agent → items) the tasks poll carries. Global,
// so every project's response repeats it; an agent with no items is simply absent.
export type FlowTelemetry = Record<string, TelemetryItem[]>

export type TaskLinkResponse =
  | { notModified: true; etag: string | null }
  | { notModified: false; etag: string | null; links: TaskLink[] }

// One installation-wide link projection, conditionally fetched. After the
// first response an unchanged poll is a bodyless 304; the server serves it from
// memory, so this neither repeats task conversations over the wire nor scans
// task files on disk.
export async function loadTaskLinks(etag?: string): Promise<TaskLinkResponse> {
  const r = await fetch('/api/task-links', {
    headers: etag ? { 'if-none-match': etag } : undefined,
  })
  if (r.status === 304)
    return { notModified: true, etag: r.headers.get('etag') ?? etag ?? null }
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? r.statusText)
  return {
    notModified: false,
    etag: r.headers.get('etag'),
    links: (body.links ?? []) as TaskLink[],
  }
}

// Request headers that mark a call as coming from the human's browser. Two jobs
// now, and the second is why routes that gate on nothing still send it:
//
//   - **Authorization.** The server gates permission-granting endpoints
//     (creating a task with edit/commit access, toggling those grants, allowing
//     a tool) on this token so a task can't hit the same API to escalate itself.
//   - **Attribution.** `resolvePrincipal` answers `anon` without it, and task
//     hooks select on the principal that caused a transition — so a land, wedge,
//     rest, launch, archive or rename sent without the token is recorded as
//     `by: system`, and a hook under `landed/human/` never fires for the single
//     most common human action there is. Every mutating call from the browser
//     sends it, whether or not the route reads it.
//
// dev.mjs hands the value to both Vite (here) and the API server. JSON
// content-type rides along since every caller that needs the token also sends a
// JSON body.
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

// What a project's tree declares under .lander/hooks/, and each declared
// version's approval state. Throws on failure — unlike loadFlows, an empty list
// here would be a claim ("this project declares no hooks") rather than a
// degradation, so the caller shows the error instead.
export async function loadHooks(slug: string): Promise<ProjectHooks> {
  const r = await fetch(`/api/${slug}/hooks`, { headers: uiHeaders() })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? r.statusText)
  return body as ProjectHooks
}

// Approve, or withdraw approval of, one version of one hook. Human-only
// server-side: an approved hook runs unattended with daemon privileges.
export async function setHookApproval(
  slug: string,
  hook: { path: string; blob: string },
  approved: boolean,
): Promise<void> {
  const r = await fetch(`/api/${slug}/hooks/${approved ? 'approve' : 'revoke'}`, {
    method: 'POST',
    headers: uiHeaders(),
    body: JSON.stringify(hook),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? r.statusText)
}

// Name the branch whose hooks run without individual approval, or clear it.
export async function setTrustedBranch(
  slug: string,
  ref: string | null,
): Promise<string | null> {
  const r = await fetch(`/api/${slug}/hooks/trust-root`, {
    method: 'POST',
    headers: uiHeaders(),
    body: JSON.stringify({ ref }),
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? r.statusText)
  return (body.ref ?? null) as string | null
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
