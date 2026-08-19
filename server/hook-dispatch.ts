// The dispatcher: takes the fires the trigger funnel recorded, asks what the
// target's tree declares, and hands each approved version to the daemon to run.
//
// Nothing durable is created before a body decides. No task, no run, no ride, no
// title generation — a fire that decides to do nothing costs a process and zero
// tokens, which is the property the whole shape exists to preserve (a judgment
// task reading a conversation can cost as much as the ride it is judging).
//
// The bookkeeping unit is **(fire, hook)**, not the fire. "Many hooks per
// trigger" is one of the design's headline properties, and with two declared and
// one erroring, a per-fire retry would re-run the healthy body too — whose direct
// effects are explicitly not deduped.
//
// Failures are classified as **attempts** or **holds**, from an allowlist of the
// former. That inversion is load-bearing rather than tidy: the boot sweep runs
// before the daemon reconnects, so every `tsx watch` reload sweeps with no daemon
// at all, and counting that as an attempt would mean five `server/**` edits
// silently discarded every pending fire in the instance.

import path from 'node:path'
import type { Project } from './projects'
import { mutateTask, readTask } from './store'
import {
  pushHookItem,
  type HookItem,
  type Item,
  type PendingHook,
} from './tasks'
import { resolveProjectHooks, selectorsFor, taskCheckout, type HookOutcome } from './hooks'
import { requestHookRun } from './daemon'
import {
  claimHookRun,
  mintHookCredential,
  releaseHookCredential,
  releaseHookRun,
  HOOK_BODY_TIMEOUT_MS,
  HOOK_DISPATCH_TIMEOUT_MS,
  HOOK_KILL_BUDGET_MS,
  MAX_CONCURRENT_HOOK_RUNS,
} from './hook-runs'
import type { HookRunReport } from './protocol'

// How many times a fire may fail in a way that is its OWN fault before its hook
// is given up on. Everything else is a hold and costs nothing.
export const MAX_HOOK_DISPATCH_ATTEMPTS = 5
// A fire nothing can resolve eventually stops being interesting. Long enough
// that an overnight daemon outage does not lose supervision.
const MAX_FIRE_AGE_MS = 24 * 60 * 60_000

// Outcomes that count against a fire's attempt budget: the run happened and went
// wrong in a way retrying is unlikely to fix. Everything NOT listed here is a
// hold — including a daemon that is absent, draining, slow, or throwing, and a
// credential this server no longer holds because it restarted.
const ATTEMPT_WORTHY = new Set<HookRunReport['outcome']>(['error', 'timeout'])
// Outcomes that finish a hook for this fire. `refused` is terminal because a
// human withdrew the approval — retrying past that is precisely what the revoke
// button says not to do.
const TERMINAL = new Set<HookRunReport['outcome']>(['ran', 'refused'])

// One dispatch loop per task at a time. A body may run for minutes, and a second
// sweep must not start the same task's fires underneath the first.
const dispatching = new Set<string>()

export function hookDispatchInFlight(): number {
  return dispatching.size
}

// Whether a loop for this task is running right now. Read synchronously by the
// sweep so an in-flight task costs no budget.
export function hookDispatchInFlightFor(
  project: { slug: string },
  id: string,
): boolean {
  return dispatching.has(`${project.slug}\0${id}`)
}

type DispatchDeps = {
  now?: () => string
  resolve?: typeof resolveProjectHooks
  run?: typeof requestHookRun
  // The base URL a host is told to call back on.
  api: string
}

// Mutate one pending entry by id, under the task lock. Keyed by id rather than
// by index because a dispatch spans minutes, during which the funnel appends
// more entries — a whole-array rewrite would drop them.
type HookTask = { items?: Item[]; pendingHooks?: PendingHook[] }

async function updateFire(
  file: string,
  fireId: string,
  fn: (entry: PendingHook, task: HookTask) => void,
): Promise<void> {
  await mutateTask<HookTask>(file, (t) => {
    const entry = (t.pendingHooks ?? []).find((f) => f.id === fireId)
    if (entry) fn(entry, t)
  }).catch(() => {})
}

async function clearFire(file: string, fireId: string): Promise<void> {
  await mutateTask<HookTask>(file, (t) => {
    if (t.pendingHooks) t.pendingHooks = t.pendingHooks.filter((f) => f.id !== fireId)
    if (t.pendingHooks?.length === 0) delete t.pendingHooks
  }).catch(() => {})
}

// Record a run's account of itself on the target's timeline. Through mutateTask,
// like every write here: a report lands up to a sweep plus a body's runtime after
// the ride closed, by which time the target is usually riding again, and a
// read-modify-write outside the lock would drop the streamed items of a live run.
async function report(
  file: string,
  entry: PendingHook,
  hook: { path: string; name: string },
  outcome: string,
  at: string,
  extra: Partial<Pick<HookItem, 'text' | 'output' | 'error' | 'durationMs'>> = {},
): Promise<void> {
  await mutateTask<HookTask>(file, (t) => {
    pushHookItem(
      t,
      {
        hook: hook.name,
        path: hook.path,
        trigger: entry.trigger,
        by: entry.by,
        fireId: entry.id,
        ...(entry.rideId ? { ride: entry.rideId } : {}),
        outcome,
        ...extra,
      },
      at,
    )
  }).catch(() => {})
}

// Dispatch every hook a task's pending fires select. Never throws: it is called
// unawaited from the scheduler sweep, where a rejection would take the server
// down — and because the entry survives a restart, the same fire would re-throw
// on the next boot, turning one bad state into a crash loop.
// Returns false when a loop for this task was already in flight, so the sweep's
// per-project budget is spent on dispatches that actually start. Counting the
// call rather than the start would let four long-running bodies consume the
// whole budget on every sweep they span — up to a dozen — while every other
// task in that project waited, silently, since a hold records nothing.
export async function dispatchPendingHooks(
  project: Project,
  id: string,
  deps: DispatchDeps,
): Promise<boolean> {
  const key = `${project.slug}\0${id}`
  if (dispatching.has(key)) return false
  dispatching.add(key)
  try {
    await dispatchTask(project, id, deps)
  } catch (e) {
    console.warn(
      `hook dispatch failed for ${project.slug}/${id}:`,
      e instanceof Error ? e.message : String(e),
    )
  } finally {
    dispatching.delete(key)
  }
  return true
}

async function dispatchTask(
  project: Project,
  id: string,
  deps: DispatchDeps,
): Promise<void> {
  const now = deps.now ?? (() => new Date().toISOString())
  const resolve = deps.resolve ?? resolveProjectHooks
  const run = deps.run ?? requestHookRun
  const file = path.join(project.dataDir, `${id}.json`)

  const task = await readTask<{
    pendingHooks?: PendingHook[]
    hookOrigin?: { path?: string }
  }>(project.dataDir, id)
  if (!task?.pendingHooks?.length) return

  for (const entry of [...task.pendingHooks]) {
    const at = now()
    if (Date.parse(at) - Date.parse(entry.at) > MAX_FIRE_AGE_MS) {
      await report(file, entry, { path: '', name: entry.trigger }, 'dispatch-failed', at, {
        error: 'gave up: nothing could resolve this fire within 24 hours',
      })
      await clearFire(file, entry.id)
      continue
    }

    // The tree that matters is the one the target is working in, so this reads
    // the task's own checkout hints. AWAITED: spreading the promise would yield
    // no properties, silently resolve every fire at the project root, and
    // typecheck cleanly, because all three hints are optional.
    const checkout = await taskCheckout(project, id)
    // The task file is gone (archived, deleted). Nothing to dispatch for and
    // nothing to report onto.
    if (!checkout) return

    const resolved = await resolve({
      project,
      select: selectorsFor(entry.trigger, entry.by),
      ...checkout,
    })
    // A hold: no daemon, a daemon error, an unreadable tree. Leave every entry
    // pending and stop — if resolution is failing for this task it is failing
    // for the rest of the sweep too.
    if (!resolved.ok) return

    // Two exemptions, and they are different questions. `hookOrigin` exempts a
    // hook from the whole life of a task it launched; `byHook` exempts it from
    // the single fire its own action caused — so a hook-initiated landing still
    // reaches every OTHER hook, which is what lets one chain into cleanup or
    // self-review while not waking the hook that landed the target.
    const exempt = new Set([task.hookOrigin?.path, entry.byHook].filter(Boolean))
    const eligible = (h: HookOutcome): boolean => !exempt.has(h.path)
    const done = new Set(entry.done ?? [])
    // Both selection axes are path segments, so a hook that does not apply to
    // this principal was never listed and is never dispatched — no process, no
    // import, no approval question.
    const applicable = resolved.hooks.hooks.filter(
      (h) => eligible(h) && !done.has(h.path),
    )

    for (const hook of applicable) {
      // No approved version anywhere in this path's ancestry. Marked done with
      // no timeline item: the first hook a project commits has no approved
      // ancestor by definition, so an item here would say "could not run" on
      // every task's timeline on every ride end for the whole window between
      // landing it and a human clicking approve. That state belongs to the
      // approval panel, not to every conversation.
      if (hook.runs === null) {
        done.add(hook.path)
        continue
      }
      const outcome = await dispatchOne(project, id, file, entry, hook, {
        api: deps.api,
        run,
        now,
      })
      if (outcome === 'hold') continue
      if (outcome === 'done') done.add(hook.path)
    }

    await updateFire(file, entry.id, (e) => {
      if (done.size) e.done = [...done]
    })
    // Every applicable hook has reported terminally (or there were none to
    // begin with, which is the common case in a project with no hooks). This
    // must apply the SAME eligibility as the dispatch loop above: an exempt hook
    // never reports, so counting it here would leave the entry unclearable —
    // re-resolved every sweep until the 24-hour ceiling gave up on it.
    const remaining = resolved.hooks.hooks.filter(
      (h) => eligible(h) && !done.has(h.path),
    )
    if (!remaining.length) await clearFire(file, entry.id)
  }
}

// Run one hook for one fire. Returns whether that hook is finished for this fire
// ('done'), should be retried later ('hold'), or has used up its budget.
async function dispatchOne(
  project: Project,
  id: string,
  file: string,
  entry: PendingHook,
  hook: HookOutcome,
  deps: {
    api: string
    run: typeof requestHookRun
    now: () => string
  },
): Promise<'done' | 'hold'> {
  // Read the checkout BEFORE claiming anything: `readTask` can reject on an
  // unreadable file, and a throw between the claim and the try below would leak
  // a live credential and one of only four instance-wide concurrency slots.
  const checkout = await taskCheckout(project, id)

  // Refuse a second live run of the same fire, and stay under the instance-wide
  // ceiling on concurrent hosts — each is a full Node process spawned by the
  // daemon that owns every in-flight agent child.
  const claim = claimHookRun(project.slug, entry.id)
  if (!claim.ok) {
    if (claim.reason === 'at-capacity')
      console.warn(
        `hook dispatch at capacity (${MAX_CONCURRENT_HOOK_RUNS} in flight); ` +
          `holding ${project.slug}/${id} ${entry.id}`,
      )
    return 'hold'
  }

  // `hook.runs`, never `hook.blob`. The two differ exactly when the tree carries
  // an unapproved edit over an approved ancestor, which is the fallback that
  // keeps an approved hook running while a new version awaits review;
  // dispatching the declared blob there would have the host's own re-check
  // refuse it forever.
  const cred = mintHookCredential({
    project: project.slug,
    target: id,
    fireId: entry.id,
    path: hook.path,
    blob: hook.runs!,
    name: hook.name,
  })

  let response
  try {
    response = await deps.run({
      project: project.slug,
      fireId: entry.id,
      target: { id, ...(checkout ?? {}) },
      trigger: {
        kind: entry.trigger,
        by: entry.by,
        at: entry.at,
        ...(entry.rideId ? { rideId: entry.rideId } : {}),
        ...(entry.outcome ? { outcome: entry.outcome } : {}),
      },
      hook: {
        path: hook.path,
        runs: hook.runs!,
        name: hook.name,
        trigger: hook.trigger,
        by: hook.by,
      },
      callback: { api: deps.api, project: project.slug, token: cred.token },
      timeoutMs: HOOK_BODY_TIMEOUT_MS,
      killMs: HOOK_KILL_BUDGET_MS,
      waitMs: HOOK_DISPATCH_TIMEOUT_MS,
    })
  } finally {
    // All three of askDaemon's settle paths — reply, timeout, and the immediate
    // unsent when no daemon is connected — release the credential here, or the
    // map leaks a live token per attempt per fire.
    releaseHookCredential(cred.token)
  }

  // The CLAIM is released only when we know nothing is still running: the daemon
  // answered, or it was never asked. On a dispatch timeout the body is probably
  // still alive on the other side, so the claim is left to expire on its own
  // TTL — which is the whole reason the claim has one. Releasing it here
  // unconditionally would make the in-flight set exactly as useful as not having
  // it: the next sweep would re-dispatch the same fire into a live body.
  if (response.ok || response.status === 503)
    releaseHookRun(project.slug, entry.id)

  const at = deps.now()
  // The daemon could not be asked, or could not answer. A hold: no attempt, no
  // timeline item, retried on the next sweep.
  if (!response.ok || !response.report) return 'hold'

  const outcome = response.report.outcome
  // The daemon already holds this fire (a re-dispatch racing a live body).
  if (outcome === 'already-running') return 'hold'
  // This server restarted and no longer holds the token. Not the fire's fault,
  // and distinct from a revocation, so neither reported nor counted.
  if (outcome === 'credential-unknown') return 'hold'

  const { reports, output, error, durationMs } = response.report
  // A body that ran and reported nothing leaves no item: the report is the
  // finding, not the fire. Everything that went wrong is always recorded.
  const worthSaying = reports.length > 0 || outcome !== 'ran'
  if (worthSaying)
    await report(file, entry, hook, outcome, at, {
      ...(reports.length ? { text: reports.join('\n\n') } : {}),
      ...(output ? { output } : {}),
      ...(error ? { error } : {}),
      ...(durationMs ? { durationMs } : {}),
    })

  if (TERMINAL.has(outcome)) return 'done'

  if (ATTEMPT_WORTHY.has(outcome)) {
    let exhausted = false
    await updateFire(file, entry.id, (e) => {
      const attempts = (e.attempts ??= {})
      attempts[hook.path] = (attempts[hook.path] ?? 0) + 1
      exhausted = attempts[hook.path] >= MAX_HOOK_DISPATCH_ATTEMPTS
    })
    if (exhausted) {
      await report(file, entry, hook, 'dispatch-failed', deps.now(), {
        error: `gave up after ${MAX_HOOK_DISPATCH_ATTEMPTS} failed runs`,
      })
      return 'done'
    }
  }
  return 'hold'
}
