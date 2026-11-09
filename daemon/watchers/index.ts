// The watchers bundled with lander, and the one place the daemon runs them.
//
// A watcher is lander's own read-only code: the agent that arms a watch supplies
// only its arguments. It runs in the daemon process, so everything it does must
// be asynchronous and bounded by `ctx.signal`.

import type { WatcherMeta, WatcherOutcome } from '../../server/protocol'
import ghChecks from './gh-checks'
import ghPrActivity from './gh-pr-activity'
import ghReviewRequests from './gh-review-requests'
import { createGitHub } from './github'
import { PermanentWatcherError, type BundledWatcher, type WatcherCtx } from './types'

const BUNDLED: BundledWatcher[] = [ghChecks, ghPrActivity, ghReviewRequests]

const github = createGitHub()

export function bundledWatcherMetas(): WatcherMeta[] {
  return BUNDLED.map((w) => w.meta)
}

function argsError(meta: WatcherMeta, args: Record<string, string>): string | null {
  for (const name of Object.keys(args))
    if (!Object.hasOwn(meta.args, name)) return `${meta.name} takes no argument "${name}"`
  for (const [name, spec] of Object.entries(meta.args))
    if (spec.required && !args[name]?.trim())
      return `${meta.name} requires --arg ${name}=…`
  return null
}

function rejectOnAbort(signal: AbortSignal, message: string): Promise<never> {
  return new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(new Error(message)), { once: true }),
  )
}

export async function runWatcher(
  name: string,
  ctx: Omit<WatcherCtx, 'signal' | 'github'>,
  args: Record<string, string>,
  prevState: unknown,
  timeoutMs: number,
  watchers: BundledWatcher[] = BUNDLED,
): Promise<WatcherOutcome> {
  const watcher = watchers.find((w) => w.meta.name === name)
  if (!watcher)
    return { kind: 'error', error: `no bundled watcher named ${name}`, permanent: true }
  const invalid = argsError(watcher.meta, args)
  if (invalid) return { kind: 'error', error: invalid, permanent: true }
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const result = await Promise.race([
      watcher.run({ ...ctx, github, signal }, args, prevState),
      rejectOnAbort(signal, `${name} timed out after ${timeoutMs / 1000}s`),
    ])
    return result.fired
      ? { kind: 'fired', state: result.state, message: result.message }
      : { kind: 'quiet', state: result.state }
  } catch (e) {
    return {
      kind: 'error',
      error: e instanceof Error ? e.message : String(e),
      permanent: e instanceof PermanentWatcherError,
    }
  }
}
