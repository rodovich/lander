// The server half of a hook *run*: the short-lived credential a hook host
// presents back, the set of fires believed to be running, and the timeout ladder
// both sides share.
//
// The approval store (hooks.ts) answers "may this version run"; this module
// answers "is this the host we dispatched, and is it still the run we think it
// is". Kept separate because the store is durable and monotonic while everything
// here is process-local and deliberately so: a hook run does not survive a server
// restart (docs/tmp/hooks.md Appendix B), and the retry re-mints. The durable
// thing is the fire id, which lives on the task.
//
// **The credential is not a `Principal`.** `resolvePrincipal` is the shared front
// door for every route, and the routes are gated individually with no middleware
// — several gate only on `anon`, and `POST /tasks/:id/messages` and
// `PATCH /tasks/:id` gate neither. A fourth principal kind would therefore hand a
// hook body the ability to append a `role: 'user'` message and drive a turn, and
// to land, wedge and interrupt its target: the nudge verb arriving early, in the
// form the design forbids, and an inversion of hooks.md §6's claim that those
// verbs are *absent from the surface* rather than denied per route. So the
// credential is read only by the routes that accept one, each re-checking the
// project and target it was minted for.

import { randomUUID } from 'node:crypto'

// The timeout ladder. Ordered, not one number: the daemon must always finish
// assembling its report before the server stops listening, or `settleRequest`
// drops a late reply, the fire is retried, and a body whose direct `ctx.spawn`
// effects are explicitly NOT deduped runs a second time.
//
//   body < daemon's hard kill + report < the server's wait
export const HOOK_BODY_TIMEOUT_MS = 120_000
export const HOOK_KILL_BUDGET_MS = 150_000
export const HOOK_DISPATCH_TIMEOUT_MS = 195_000
// How long a fire stays in the in-flight set. Past the daemon's kill budget, so
// it covers the one case it can — a re-dispatch after the dispatch timeout while
// the first body is somehow still alive — and expires on its own if a release is
// ever missed. A leaked entry would otherwise consume a concurrency slot forever.
const INFLIGHT_TTL_MS = 200_000
// Credentials outlive the exchange by the same margin, so a host still running
// past the server's wait can still be told its approval was withdrawn rather than
// getting a confusing unknown-token answer.
const CREDENTIAL_TTL_MS = 200_000

// How many hook hosts may be in flight across the whole instance. Each is a full
// Node process spawned by the daemon that owns every in-flight agent child;
// daemon/hooks.ts caps its own git fan-out at 4 over strictly lighter work.
export const MAX_CONCURRENT_HOOK_RUNS = 4

export type HookCredential = {
  token: string
  // The slug and task the credential is scoped to. Re-checked by every route
  // that accepts one, so a credential minted for one target cannot act on
  // another.
  project: string
  target: string
  fireId: string
  // The pair the host is permitted to materialize — the blob that will actually
  // run (HookOutcome.runs), which for an unapproved edit over an approved
  // ancestor is the ancestor.
  path: string
  blob: string
  name: string
  expiresAt: number
}

const credentials = new Map<string, HookCredential>()
// Fires believed to be running, by `${project}\0${fireId}`, with the wall-clock
// deadline past which we stop believing it.
const inFlight = new Map<string, number>()

function sweepExpired(now: number): void {
  for (const [token, cred] of credentials)
    if (cred.expiresAt <= now) credentials.delete(token)
  for (const [key, deadline] of inFlight) if (deadline <= now) inFlight.delete(key)
}

function fireKey(project: string, fireId: string): string {
  return `${project}\0${fireId}`
}

export function mintHookCredential(
  input: Omit<HookCredential, 'token' | 'expiresAt'>,
  now = Date.now(),
): HookCredential {
  sweepExpired(now)
  const cred: HookCredential = {
    ...input,
    token: randomUUID(),
    expiresAt: now + CREDENTIAL_TTL_MS,
  }
  credentials.set(cred.token, cred)
  return cred
}

export function releaseHookCredential(token: string): void {
  credentials.delete(token)
}

// The credential a request presents, or undefined when the token is unknown or
// expired. Unknown is a distinct answer from "not approved": the server restarts
// on every `server/**` edit, taking this map with it, and a host mid-run then
// gets a token miss that is nobody's fault and must not burn a retry attempt.
export function readHookCredential(
  token: string | undefined,
  now = Date.now(),
): HookCredential | undefined {
  if (!token) return undefined
  const cred = credentials.get(token)
  if (!cred) return undefined
  if (cred.expiresAt <= now) {
    credentials.delete(token)
    return undefined
  }
  return cred
}

// Claim a fire as in flight. Refuses when it is already claimed (a re-dispatch
// racing a live body) or when the instance is at its concurrency ceiling. The
// two share a structure so a leaked claim shows up as a saturated cap rather
// than as silence.
export function claimHookRun(
  project: string,
  fireId: string,
  now = Date.now(),
): { ok: true } | { ok: false; reason: 'already-running' | 'at-capacity' } {
  sweepExpired(now)
  const key = fireKey(project, fireId)
  if (inFlight.has(key)) return { ok: false, reason: 'already-running' }
  if (inFlight.size >= MAX_CONCURRENT_HOOK_RUNS)
    return { ok: false, reason: 'at-capacity' }
  inFlight.set(key, now + INFLIGHT_TTL_MS)
  return { ok: true }
}

export function releaseHookRun(project: string, fireId: string): void {
  inFlight.delete(fireKey(project, fireId))
}

export function hookRunsInFlight(now = Date.now()): number {
  sweepExpired(now)
  return inFlight.size
}

// Test seam: both maps are process-local and time-keyed, so nothing in
// production clears them wholesale.
export function clearHookRunState(): void {
  credentials.clear()
  inFlight.clear()
}
