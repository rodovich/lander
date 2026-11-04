// The watch checks bundled with lander, and the one place the daemon runs them.
//
// A check is lander's own read-only code: the agent that arms a watch supplies
// only its arguments. It runs in the daemon process, so everything it does must
// be asynchronous and bounded by `ctx.signal`.

import type { CheckMeta, CheckOutcome } from '../../server/protocol'
import ghPrActivity from './gh-pr-activity'
import ghReviewRequests from './gh-review-requests'
import { createGitHub } from './github'
import { PermanentCheckError, type BundledCheck, type CheckCtx } from './types'

const BUNDLED: BundledCheck[] = [ghPrActivity, ghReviewRequests]

const github = createGitHub()

export function bundledCheckMetas(): CheckMeta[] {
  return BUNDLED.map((c) => c.meta)
}

function argsError(meta: CheckMeta, args: Record<string, string>): string | null {
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

export async function runCheck(
  name: string,
  ctx: Omit<CheckCtx, 'signal' | 'github'>,
  args: Record<string, string>,
  prevState: unknown,
  timeoutMs: number,
  checks: BundledCheck[] = BUNDLED,
): Promise<CheckOutcome> {
  const check = checks.find((c) => c.meta.name === name)
  if (!check)
    return { kind: 'error', error: `no bundled check named ${name}`, permanent: true }
  const invalid = argsError(check.meta, args)
  if (invalid) return { kind: 'error', error: invalid, permanent: true }
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const result = await Promise.race([
      check.run({ ...ctx, github, signal }, args, prevState),
      rejectOnAbort(signal, `${name} timed out after ${timeoutMs / 1000}s`),
    ])
    return result.fired
      ? { kind: 'fired', state: result.state, message: result.message }
      : { kind: 'quiet', state: result.state }
  } catch (e) {
    return {
      kind: 'error',
      error: e instanceof Error ? e.message : String(e),
      permanent: e instanceof PermanentCheckError,
    }
  }
}
