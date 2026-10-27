import type { TaskMatches, TaskSearch } from '../shared/conversationSearch'
import type { StatsFacts } from './stats'
import { taskKey, type TaskRef } from './taskRef'
import type {
  FlowCaps,
  FlowMeta,
  Item,
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

// How long a poll-shaped read may run, headers and body together, before the
// client gives up on it. Nothing else bounds one: the dev proxy can strand a
// response mid-body when the server restarts, and `fetch` alone would wait
// until the OS dropped the socket — and the poll loop waiting on it would stop
// with it. Generous on purpose: an idle full-list answer is ~200ms and under
// load the point is to outlast seconds, not to police them.
export const READ_TIMEOUT_MS = 30_000

// The abort that enforces READ_TIMEOUT_MS, and the error it surfaces as. The
// DOMException's own message ("signal timed out") names neither the request nor
// the bound, and it is what the poll's error banner would show.
const readTimeout = () => AbortSignal.timeout(READ_TIMEOUT_MS)
function describeTimeout(e: unknown, url: string): unknown {
  return e instanceof DOMException && e.name === 'TimeoutError'
    ? new Error(`no response from ${url} within ${READ_TIMEOUT_MS / 1000}s`)
    : e
}

// A response whose body wasn't the JSON the route promises. Same standard as the
// timeout above, for the same reason: `JSON.parse('')` throws "Unexpected end of
// JSON input", which names neither the request nor the cause, and the poll's
// error banner is where it would land.
const unreadable = (url: string, status: number) =>
  new Error(`unreadable response from ${url} (HTTP ${status})`)

// The JSON body of a response, or an error describing why there isn't one. A
// body that fails to parse is routine rather than hypothetical: the dev proxy
// answers a request it cannot reach the API server with — every `tsx watch`
// restart opens a window of those — with an empty 500, and a restart mid-response
// truncates a 200.
async function readJson(
  url: string,
  valid?: (body: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  try {
    const r = await fetch(url, { signal: readTimeout() })
    const body = (await r.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined
    if (!r.ok) {
      const stated = typeof body?.error === 'string' ? body.error : ''
      throw new Error(
        stated || `${url} failed: HTTP ${r.status} ${r.statusText}`.trimEnd(),
      )
    }
    if (!body || (valid && !valid(body))) throw unreadable(url, r.status)
    return body
  } catch (e) {
    throw describeTimeout(e, url)
  }
}

// One installation-wide link projection, conditionally fetched. After the
// first response an unchanged poll is a bodyless 304; the server serves it from
// memory, so this neither repeats task conversations over the wire nor scans
// task files on disk.
export async function loadTaskLinks(etag?: string): Promise<TaskLinkResponse> {
  const url = '/api/task-links'
  try {
    const r = await fetch(url, {
      headers: etag ? { 'if-none-match': etag } : undefined,
      signal: readTimeout(),
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
  } catch (e) {
    throw describeTimeout(e, url)
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

// One stored attachment's bytes, or null when the server won't serve them.
// Fetched through JS because the UI token can't ride a bare media or download
// URL; blob URLs made from the result can then be handed to the browser's
// native image, media, and PDF renderers.
export async function loadAttachment(
  slug: string,
  id: string,
): Promise<Blob | null> {
  const token = import.meta.env.VITE_LANDER_UI_TOKEN
  const r = await fetch(`/api/${slug}/attachments/${id}`, {
    headers: token ? { 'x-lander-ui-token': token } : {},
  })
  return r.ok ? r.blob() : null
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

// Every configured project's stats facts; the dashboard narrows and buckets
// them itself.
export async function loadStats(): Promise<StatsFacts> {
  return (await readJson('/api/stats')) as StatsFacts
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

export async function loadTask(
  slug: string,
  id: string,
): Promise<TaskWithProject> {
  const body = await readJson(
    `/api/${slug}/tasks/${id}`,
    (b) => typeof b.id === 'string',
  )
  return {
    ...(body as unknown as Task),
    items: Array.isArray(body.items) ? (body.items as Item[]) : [],
    projectSlug: slug,
  }
}

// A conversation search to run alongside a list load: the query, and the tasks
// whose match lists should run longer than the server's default.
export type TaskSearchRequest = {
  query: string
  limits: (TaskRef & { limit: number })[]
}

// What a search found: the query it ran (which can trail the one being typed),
// and each matching task's matches, by task key.
export type TaskSearchResult = {
  query: string
  matches: Map<string, TaskMatches>
}

// Fetch and merge tasks across every shown project, tagging each with its
// project slug and sorting the combined list by recency. The tasks come back as
// the metadata-only projection (see taskSummary), without `items`/`rides`,
// which is the whole conversation and ~99% of the bytes; `search` has the
// server search those conversations.
export async function loadShownTasks(
  slugs: string[],
  includeArchived: boolean,
  search?: TaskSearchRequest,
): Promise<{
  tasks: TaskWithProject[]
  telemetry: FlowTelemetry
  flows: Record<string, FlowCaps>
  search: TaskSearchResult | null
}> {
  const lists = await Promise.all(
    slugs.map(async (slug) => {
      const params = new URLSearchParams()
      if (includeArchived) params.set('archived', '1')
      params.set('view', 'summary')
      if (search) {
        params.set('q', search.query)
        const expand = search.limits
          .filter((l) => l.projectSlug === slug)
          .map((l) => `${l.id}:${l.limit}`)
        if (expand.length > 0) params.set('expand', expand.join(','))
      }
      const url = `/api/${slug}/tasks?${params}`
      // A parsed body still owes us the list. Without this the truncated-200
      // case reaches `.map` and reads as "Cannot read properties of undefined".
      const body = await readJson(url, (b) => Array.isArray(b.tasks))
      const found = body.search as TaskSearch | undefined
      return {
        tasks: (body.tasks as Task[]).map((t) => ({ ...t, projectSlug: slug })),
        telemetry: (body.telemetry ?? {}) as FlowTelemetry,
        flows: (body.flows ?? {}) as Record<string, FlowCaps>,
        found: found && {
          query: found.query,
          matches: Object.entries(found.matches).map(
            ([id, m]) => [taskKey(slug, id), m] as const,
          ),
        },
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
  const found = lists.flatMap((l) => (l.found ? [l.found] : []))
  return {
    tasks: merged,
    telemetry,
    // Global like telemetry: every project's response carries the same map.
    flows: lists.map((l) => l.flows).find((f) => Object.keys(f).length > 0) ?? {},
    search:
      found.length > 0
        ? { query: found[0].query, matches: new Map(found.flatMap((f) => f.matches)) }
        : null,
  }
}
