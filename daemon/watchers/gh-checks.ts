import { getJson, parsePr, parseRepo } from './github'
import { PermanentWatcherError, type BundledWatcher, type WatcherCtx } from './types'

type CheckRun = {
  name: string
  status: string
  conclusion: string | null
  html_url: string
}

type CommitStatus = { context: string; state: string; target_url: string | null }

// One check on the commit, from either GitHub's check runs or its older commit
// statuses, which some CI systems still report through.
type Check = { name: string; done: boolean; failed: boolean; url: string | null }

type State = { sha: string; emptyRuns: number; finished?: string }

// Runs in a row that find no checks at all before the watch says so, about half
// an hour at the watch interval: a commit some CI never reports on would
// otherwise be watched forever.
const MAX_EMPTY_RUNS = 6

const PASSED = new Set(['success', 'neutral', 'skipped'])

function target(args: Record<string, string>): { repo: string; pr?: number; sha?: string } {
  if (args.pr) {
    const { repo, number } = parsePr(args.pr)
    return { repo, pr: number }
  }
  if (args.repo && args.sha) {
    if (!/^[0-9a-f]{7,40}$/i.test(args.sha))
      throw new PermanentWatcherError(`sha must be a commit hash, not "${args.sha}"`)
    return { repo: parseRepo(args.repo), sha: args.sha }
  }
  throw new PermanentWatcherError('gh-checks needs --arg pr=… or both --arg repo=… and --arg sha=…')
}

async function checks(ctx: WatcherCtx, repo: string, sha: string): Promise<Check[]> {
  const runs: CheckRun[] = []
  for (let page = 1; ; page++) {
    const body = await getJson<{ check_runs: CheckRun[] }>(
      ctx,
      `/repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`,
    )
    runs.push(...body.check_runs)
    if (body.check_runs.length < 100) break
  }
  const { statuses } = await getJson<{ statuses: CommitStatus[] }>(
    ctx,
    `/repos/${repo}/commits/${sha}/status?per_page=100`,
  )
  return [
    ...runs.map((r) => ({
      name: r.name,
      done: r.status === 'completed',
      failed: r.status === 'completed' && !PASSED.has(r.conclusion ?? ''),
      url: r.html_url,
    })),
    ...statuses.map((s) => ({
      name: s.context,
      done: s.state !== 'pending',
      failed: s.state === 'failure' || s.state === 'error',
      url: s.target_url,
    })),
  ]
}

const ghChecks: BundledWatcher = {
  meta: {
    name: 'gh-checks',
    description:
      "Fires when a pull request's or commit's CI checks have all finished, or at the first failure with fail-fast. Follows a PR to its new head when commits are pushed. Reads GitHub as you, with the token `gh auth token` prints.",
    args: {
      pr: { description: 'owner/repo#123 or a pull request URL. Or give repo and sha instead.' },
      repo: { description: 'owner/repo, with sha, to watch one commit.' },
      sha: { description: 'The commit to watch, with repo.' },
      'fail-fast': { description: '"true" to fire at the first failed check.' },
    },
  },
  async run(ctx, args, prevState) {
    const { repo, pr, sha: fixed } = target(args)
    if (args['fail-fast'] && args['fail-fast'] !== 'true')
      throw new PermanentWatcherError('fail-fast must be "true" when given')
    const prev = prevState as State | undefined
    const sha =
      fixed ??
      (await getJson<{ head: { sha: string } }>(ctx, `/repos/${repo}/pulls/${pr}`)).head.sha
    const short = sha.slice(0, 7)
    const all = await checks(ctx, repo, sha)
    const emptyRuns = all.length ? 0 : (prev?.sha === sha ? prev.emptyRuns : 0) + 1
    const state: State = { sha, emptyRuns }
    const read = pr ? `\nSee them with \`gh pr checks ${pr} --repo ${repo}\`.` : ''
    const line = (c: Check) => `- ${c.name}${c.url ? `: ${c.url}` : ''}`

    const firedState: State = { sha, emptyRuns: 0 }

    if (!all.length)
      return emptyRuns >= MAX_EMPTY_RUNS
        ? {
            fired: true,
            state: firedState,
            message: `No checks have reported on ${short} in ${repo} for about half an hour.`,
          }
        : { fired: false, state }
    const failed = all.filter((c) => c.failed)
    const pending = all.filter((c) => !c.done)
    if (pending.length && !(failed.length && args['fail-fast'] === 'true'))
      return { fired: false, state }
    // CI systems register their checks at different times, so nothing pending
    // doesn't yet mean nothing more is coming. A pass waits for one run to find
    // the same finished set.
    const finished = all.map((c) => c.name).sort().join('\n')
    if (!failed.length && !(prev?.sha === sha && prev.finished === finished))
      return { fired: false, state: { ...state, finished } }
    const message = failed.length
      ? [
          `${failed.length} of ${all.length} checks failed on ${short} in ${repo}` +
            (pending.length ? ` (${pending.length} still running)` : '') +
            ':',
          ...failed.map(line),
        ].join('\n') + read
      : `${all.length === 1 ? 'The only check' : `All ${all.length} checks`} passed on ${short} in ${repo}.${read}`
    return { fired: true, state: firedState, message }
  },
}

export default ghChecks
