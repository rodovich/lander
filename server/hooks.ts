// The hook approval store, and the join that turns a daemon's answer about a
// tree into "what would actually run here".
//
// The store is deliberately repository-free: an optional trust root (a ref name
// the server never resolves) and a monotonic set of approved (path, blob) pairs,
// which are opaque strings. Every git question — what a tree declares, whether a
// pair is on the trust root — is the daemon's, because the server has no
// repository access and must not gain any (docs/tmp/hooks-plan.md §2, §3).
//
// Two properties the shape encodes:
//
//   - **The pair, not the blob.** With the trigger in the path, identical content
//     at a different path fires at a different time, so moving an approved module
//     from `hooks/wedged/` to `hooks/landed/` must not carry its approval along.
//   - **Monotonic.** Approving a new version never un-approves an old one, so a
//     pending version cannot block anything and a tree that has not pulled the
//     new version keeps running the one it has.

import type { Project } from './projects'
import { mutateJson, readTask } from './store'
import { readFile } from 'node:fs/promises'
import { requestHooksResolution } from './daemon'
import type {
  HookDeclaration,
  HookPair,
  HookSelector,
  HooksResolution,
} from './protocol'

// How a pair came to be approved. `trust-root` entries are a cache of a git
// answer — the pair was found on the project's trust root — and are ignored while
// that trust root is disabled or re-pointed. `content` entries are a human's
// explicit act and are never conditional.
export type HookApprovalVia = 'trust-root' | 'content'

export type HookApproval = {
  path: string
  blob: string
  via: HookApprovalVia
  // The trust root the pair was found on. Recorded so that re-pointing the trust
  // root does not silently inherit the previous one's approvals.
  ref?: string
  at: string
}

export type HooksStore = {
  // The remote-tracking ref whose contents this project approves at project
  // level. `null` is a deliberate refusal — content approval only — and
  // `undefined` is "never designated", which behaves the same way but is a
  // different statement and should read differently to a human.
  trustRoot?: string | null
  approved: HookApproval[]
}

export function emptyHooksStore(): HooksStore {
  return { approved: [] }
}

// A ref name as a human designated it. The daemon validates this too, and must:
// it is the one string in a resolve request that did not come out of the
// repository, and it reaches an argv there. Rejecting it here as well means a bad
// value never reaches the store to be sent repeatedly.
export function isSafeTrustRoot(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) && !ref.includes('..')
}

export async function readHooksStore(file: string): Promise<HooksStore> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as HooksStore
    return {
      ...parsed,
      approved: Array.isArray(parsed.approved) ? parsed.approved : [],
    }
  } catch {
    return emptyHooksStore()
  }
}

export function pairKey(pair: HookPair): string {
  return `${pair.path}\0${pair.blob}`
}

// The pairs that count as approved right now. A trust-root entry counts only
// while the project still designates the ref it was found on — which is what
// makes disabling the trust root mean "everything requires content approval"
// rather than "everything approved so far stays approved".
export function effectiveApprovals(
  store: HooksStore,
): Map<string, HookApprovalVia> {
  const out = new Map<string, HookApprovalVia>()
  for (const entry of store.approved) {
    if (entry.via === 'trust-root') {
      if (!store.trustRoot || entry.ref !== store.trustRoot) continue
    }
    // A content approval outranks a cached trust-root one: it is unconditional,
    // so it is the more durable answer to "why does this run".
    if (entry.via === 'content' || !out.has(pairKey(entry)))
      out.set(pairKey(entry), entry.via)
  }
  return out
}

// Add pairs to the monotonic set, skipping any already recorded the same way.
// Returns the committed store so a caller can join against exactly what landed.
export function approveHookPairs(
  file: string,
  pairs: HookPair[],
  via: HookApprovalVia,
  opts: { ref?: string; at: string },
): Promise<HooksStore> {
  return mutateJson<HooksStore>(file, emptyHooksStore, (store) => {
    if (!Array.isArray(store.approved)) store.approved = []
    const seen = new Set(
      store.approved
        .filter((e) => e.via === via && e.ref === opts.ref)
        .map(pairKey),
    )
    for (const pair of pairs) {
      if (seen.has(pairKey(pair))) continue
      seen.add(pairKey(pair))
      store.approved.push({
        path: pair.path,
        blob: pair.blob,
        via,
        ...(opts.ref ? { ref: opts.ref } : {}),
        at: opts.at,
      })
    }
  })
}

// Designate the trust root, or refuse one (`null`). Never touches the approved
// set: the entries are monotonic, and re-designating the same ref later should
// find its cached answers still there rather than rescan the history.
export function setTrustRoot(
  file: string,
  ref: string | null,
): Promise<HooksStore> {
  return mutateJson<HooksStore>(file, emptyHooksStore, (store) => {
    store.trustRoot = ref
  })
}

// ── The join ───────────────────────────────────────────────────────────────

export type HookOutcome = {
  path: string
  blob: string
  trigger: string
  by: string
  name: string
  // Whether the version this tree declares may run.
  state: 'approved' | 'pending'
  via?: HookApprovalVia
  // The blob that would actually run: the declared one when approved, otherwise
  // the most recent approved version in this path's ancestry, otherwise nothing.
  // Activation propagates the way code does — approving a version arms it only
  // where the tree contains it.
  runs: string | null
  runsVia?: HookApprovalVia
  // Why `runs` is not the declared blob.
  reason?: 'unapproved-version' | 'no-approved-version'
  // The ancestry walk hit its limit, so 'no-approved-version' means "none found
  // within the limit" rather than "none exists".
  searchTruncated?: boolean
}

export function joinResolution(
  resolution: HooksResolution,
  approvals: Map<string, HookApprovalVia>,
): HookOutcome[] {
  return (resolution.declared ?? []).map((d) => {
    const via = approvals.get(pairKey(d))
    if (via)
      return { ...strip(d), state: 'approved' as const, via, runs: d.blob, runsVia: via }
    for (const blob of d.ancestry) {
      const ancestorVia = approvals.get(pairKey({ path: d.path, blob }))
      if (ancestorVia)
        return {
          ...strip(d),
          state: 'pending' as const,
          runs: blob,
          runsVia: ancestorVia,
          reason: 'unapproved-version' as const,
        }
    }
    return {
      ...strip(d),
      state: 'pending' as const,
      runs: null,
      reason: 'no-approved-version' as const,
      ...(d.ancestryTruncated ? { searchTruncated: true } : {}),
    }
  })
}

// The declaration's identity, without the ancestry the join has already consumed.
function strip(
  d: HookDeclaration,
): Pick<HookDeclaration, 'path' | 'blob' | 'trigger' | 'by' | 'name'> {
  const { path, blob, trigger, by, name } = d
  return { path, blob, trigger, by, name }
}

// Every pair a resolution raises a question about: the declared version and every
// earlier version of the same path, since the fallback may land on any of them.
export function candidatePairs(resolution: HooksResolution): HookPair[] {
  const out: HookPair[] = []
  for (const d of resolution.declared ?? []) {
    out.push({ path: d.path, blob: d.blob })
    for (const blob of d.ancestry) out.push({ path: d.path, blob })
  }
  return out
}

// ── Trust-root miss cache ──────────────────────────────────────────────────
//
// A history scan that found nothing is only worth repeating once the trust root
// has moved: until then the answer cannot change. Keyed by the tip commit, so it
// invalidates itself exactly when the fact it records could become false — and
// held in memory only, because it is derivable and a wrong survival across a
// restart would be a *stale negative*, the direction that costs an approval
// prompt rather than an unapproved run.
const missCache = new Map<string, { tip: string; misses: Set<string> }>()

function recordMisses(
  slug: string,
  tip: string,
  asked: HookPair[],
  found: HookPair[],
  truncated: string[],
): void {
  const entry = missCache.get(slug)
  const misses =
    entry && entry.tip === tip ? entry.misses : new Set<string>()
  const foundKeys = new Set(found.map(pairKey))
  for (const pair of asked) {
    // A truncated walk did not prove absence, so its miss is not cacheable.
    if (truncated.includes(pair.path)) continue
    if (!foundKeys.has(pairKey(pair))) misses.add(pairKey(pair))
  }
  missCache.set(slug, { tip, misses })
}

function cachedMisses(slug: string, tip: string): Set<string> {
  const entry = missCache.get(slug)
  return entry && entry.tip === tip ? entry.misses : new Set()
}

// Test seam: the cache is process-local and keyed by a tip that changes on its
// own, so nothing in production clears it.
export function clearHookMissCache(): void {
  missCache.clear()
}

// ── Resolution ─────────────────────────────────────────────────────────────

export type ProjectHooks = {
  cwd: string
  commit?: string
  reason?: string
  trustRoot: {
    // The designated ref, or null when the project refuses one.
    ref: string | null
    // False before anyone has designated or refused one.
    configured: boolean
    commit?: string
    reason?: string
  }
  hooks: HookOutcome[]
}

export type ResolveProjectHooksResult =
  | { ok: true; hooks: ProjectHooks }
  | { ok: false; error: string; status: number }

// What a project's tree declares for a trigger, and what each pair's approval
// state is. Two round trips at most: the daemon enumerates (and reports its trust
// root's tip), then — only for pairs neither the store nor that tip can answer —
// scans the trust root's history for versions that have since moved on. Both
// answers are cached, so the scan happens at most once per pair per tip.
export async function resolveProjectHooks(input: {
  project: Project
  select?: HookSelector[]
  // The target's checkout, when resolving for a particular task: the tree that
  // matters is the one it is working in.
  flow?: string
  recordedCwd?: string
  worktree?: string
  now?: () => string
}): Promise<ResolveProjectHooksResult> {
  const { project } = input
  const now = input.now ?? (() => new Date().toISOString())
  let store = await readHooksStore(project.hooksFile)
  const trustRoot =
    store.trustRoot && isSafeTrustRoot(store.trustRoot) ? store.trustRoot : undefined
  const target = {
    project: project.slug,
    ...(input.flow ? { flow: input.flow } : {}),
    ...(input.recordedCwd ? { recordedCwd: input.recordedCwd } : {}),
    ...(input.worktree ? { worktree: input.worktree } : {}),
    ...(trustRoot ? { trustRoot } : {}),
  }

  const first = await requestHooksResolution({
    ...target,
    declare: { ...(input.select?.length ? { select: input.select } : {}) },
  })
  if (!first.ok || !first.resolution)
    return {
      ok: false,
      error: first.error ?? 'daemon did not resolve hooks',
      status: first.status ?? 502,
    }
  const resolution = first.resolution

  // Learn every pair the trust root's tip carries, whether or not this tree
  // declares it: it has passed the project's own review gate, and recording it
  // now is what keeps the answer from being re-derived per request.
  const tip = resolution.trustRoot?.tip ?? []
  if (tip.length && trustRoot)
    store = await approveHookPairs(project.hooksFile, tip, 'trust-root', {
      ref: trustRoot,
      at: now(),
    })

  let approvals = effectiveApprovals(store)
  const tipCommit = resolution.trustRoot?.commit
  if (trustRoot && tipCommit) {
    const misses = cachedMisses(project.slug, tipCommit)
    const unknown = dedupePairs(
      candidatePairs(resolution).filter(
        (p) => !approvals.has(pairKey(p)) && !misses.has(pairKey(p)),
      ),
    )
    if (unknown.length) {
      const second = await requestHooksResolution({
        ...target,
        history: { pairs: unknown },
      })
      const found = second.resolution?.trustRoot?.found ?? []
      if (second.ok && second.resolution?.trustRoot?.commit === tipCommit) {
        recordMisses(
          project.slug,
          tipCommit,
          unknown,
          found,
          second.resolution.trustRoot.historyTruncated ?? [],
        )
        if (found.length) {
          store = await approveHookPairs(project.hooksFile, found, 'trust-root', {
            ref: trustRoot,
            at: now(),
          })
          approvals = effectiveApprovals(store)
        }
      }
    }
  }

  return {
    ok: true,
    hooks: {
      cwd: resolution.cwd,
      ...(resolution.commit ? { commit: resolution.commit } : {}),
      ...(resolution.reason ? { reason: resolution.reason } : {}),
      trustRoot: {
        ref: store.trustRoot ?? null,
        configured: store.trustRoot !== undefined,
        ...(resolution.trustRoot?.commit
          ? { commit: resolution.trustRoot.commit }
          : {}),
        ...(resolution.trustRoot?.reason
          ? { reason: resolution.trustRoot.reason }
          : {}),
      },
      hooks: joinResolution(resolution, approvals),
    },
  }
}

function dedupePairs(pairs: HookPair[]): HookPair[] {
  const seen = new Set<string>()
  return pairs.filter((p) => {
    if (seen.has(pairKey(p))) return false
    seen.add(pairKey(p))
    return true
  })
}

// The selectors a transition resolves against: the principal that caused it, and
// `any`. Both are directory names, so a hook that does not apply to this
// principal is never even listed — no module is imported to find that out.
export function selectorsFor(trigger: string, by: string): HookSelector[] {
  return by === 'any'
    ? [{ trigger, by: 'any' }]
    : [
        { trigger, by },
        { trigger, by: 'any' },
      ]
}

// The checkout hints for a task, so resolution reads the tree that task is
// working in rather than the project root.
export async function taskCheckout(
  project: Project,
  id: string,
): Promise<{ flow?: string; recordedCwd?: string; worktree?: string } | null> {
  const task = await readTask<{
    flow?: string
    agent?: string
    cwd?: string
    worktree?: string
  }>(project.dataDir, id)
  if (!task) return null
  const flow = task.flow ?? task.agent
  return {
    ...(flow ? { flow } : {}),
    ...(task.cwd ? { recordedCwd: task.cwd } : {}),
    ...(task.worktree ? { worktree: task.worktree } : {}),
  }
}
