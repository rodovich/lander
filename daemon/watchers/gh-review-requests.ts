import { getJson, iso, parseRepo, timeline, viewer as viewerOf } from './github'
import type { BundledWatcher, WatcherCtx } from './types'

type SearchItem = {
  number: number
  title: string
  html_url: string
  user: { login: string }
  repository_url: string
}

type SearchPage = { items: SearchItem[]; incomplete_results?: boolean }

// The PRs requesting your review as of the last run. A request is new when its
// PR wasn't among them: GitHub clears a request once you review, so a re-request
// brings the PR back and is reported again.
type State = { requested: string[] }

// GitHub's search returns at most 1,000 results.
const MAX_PAGES = 10
// Beyond this many new requests in one run, the rest are listed without the
// timeline lookup that times and labels them, to stay within the watcher's budget.
const MAX_DESCRIBED = 10

function repoOf(item: SearchItem): string {
  return item.repository_url.replace(/^.*\/repos\//, '')
}

function prKey(item: SearchItem): string {
  return `${repoOf(item)}#${item.number}`
}

// When the open request was made, and whether you have reviewed the PR. The
// search can match a PR through any of your teams and the timeline doesn't say
// which teams are yours, so the latest request to you or to any team is taken.
// Best effort: the request is reported either way.
async function describeRequest(
  ctx: WatcherCtx,
  item: SearchItem,
  viewer: string,
): Promise<string> {
  try {
    const events = await timeline(ctx, repoOf(item), item.number)
    const at = events
      .filter(
        (e) =>
          e.event === 'review_requested' &&
          e.created_at &&
          (e.requested_reviewer?.login === viewer || e.requested_team),
      )
      .at(-1)?.created_at
    const reviewed = events.some((e) => e.event === 'reviewed' && e.user?.login === viewer)
    const when = at ? ` at ${iso(at)}` : ''
    if (reviewed) return ` — a re-request${when}; you reviewed this PR before`
    return at ? ` — requested${when}` : ''
  } catch {
    return ''
  }
}

const ghReviewRequests: BundledWatcher = {
  meta: {
    name: 'gh-review-requests',
    description:
      'Fires when a pull request requests your review, including a re-request on one you reviewed before. Reads GitHub as you, with the token `gh auth token` prints.',
    args: {
      org: { description: 'Only PRs in this organization or user’s repositories.' },
      repo: { description: 'Only PRs in this repository, as owner/repo.' },
      direct: {
        description: '"true" to count only requests naming you, not your teams.',
      },
      existing: {
        description: '"true" to report the requests already waiting on the first run.',
      },
    },
  },
  async run(ctx, args, prevState) {
    if (args.repo) parseRepo(args.repo)
    const prev = (prevState as Partial<State> | undefined)?.requested
    const me = await viewerOf(ctx)
    const terms = [
      'is:pr',
      'is:open',
      `${args.direct === 'true' ? 'user-review-requested' : 'review-requested'}:${me}`,
      ...(args.org ? [`org:${args.org}`] : []),
      ...(args.repo ? [`repo:${args.repo}`] : []),
    ]
    const items: SearchItem[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await getJson<SearchPage>(
        ctx,
        `/search/issues?q=${encodeURIComponent(terms.join(' '))}&sort=created&per_page=100&page=${page}`,
      )
      // A partial answer would make the missing PRs look new when they return.
      if (res.incomplete_results) return { fired: false, state: prevState }
      items.push(...res.items)
      if (res.items.length < 100) break
    }
    const before = new Set(prev ?? [])
    const fresh = items.filter((item) => !before.has(prKey(item)))
    const state: State = { requested: items.map(prKey) }
    if (!fresh.length || (!prev && args.existing !== 'true')) return { fired: false, state }
    const lines = await Promise.all(
      fresh.map(
        async (item, i) =>
          `- ${prKey(item)}: ${item.title} (by ${item.user.login}) ${item.html_url}${
            i < MAX_DESCRIBED ? await describeRequest(ctx, item, me) : ''
          }`,
      ),
    )
    return { fired: true, state, message: ['Review requests:', ...lines].join('\n') }
  },
}

export default ghReviewRequests
