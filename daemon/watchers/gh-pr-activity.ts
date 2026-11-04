import { getJson, iso, timeline, viewer as viewerOf, type Login, type TimelineEvent } from './github'
import { PermanentWatcherError, type BundledWatcher } from './types'

type Pr = {
  state: string
  merged: boolean
  merged_by?: Login | null
  user: Login
  head: { sha: string }
  html_url: string
}

// Events are remembered by id rather than by time, because GitHub can stamp an
// event earlier than one already seen: a comment drafted in a pending review
// keeps its draft time when the review is submitted. `pending` holds a response
// that has not yet settled, and `waits` how many runs it has waited.
type State = {
  seen: string[]
  headSha: string
  pending?: string[]
  waits?: number
}

// A response that is still growing after waiting this many runs is reported
// anyway, so a busy PR can't put its wake off indefinitely.
const MAX_WAITS = 3

// One thing the other side did, already worded for the wake message.
type Activity = { id: string; at: string; who: Login; line: string; immediate?: boolean }

function parsePr(arg: string): { repo: string; number: number } {
  const m =
    arg.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/) ??
    arg.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/)
  if (!m) throw new PermanentWatcherError(`pr must be owner/repo#123 or a PR URL, not "${arg}"`)
  return { repo: m[1], number: Number(m[2]) }
}

function activities(events: TimelineEvent[], viewer: string): Activity[] {
  const out: Activity[] = []
  for (const e of events) {
    switch (e.event) {
      case 'commented':
        if (e.actor && e.created_at)
          out.push({
            id: `c${e.id}`,
            at: iso(e.created_at),
            who: e.actor,
            line: `${e.actor.login} commented: ${e.html_url}`,
          })
        break
      case 'reviewed':
        if (e.user && e.submitted_at)
          out.push({
            id: `r${e.id}`,
            at: iso(e.submitted_at),
            who: e.user,
            line: `${e.user.login} reviewed (${e.state?.toLowerCase().replace('_', ' ')}): ${e.html_url}`,
          })
        break
      case 'line-commented':
        for (const c of e.comments ?? [])
          if (c.user && c.created_at)
            out.push({
              id: `l${c.id}`,
              at: iso(c.created_at),
              who: c.user,
              line: `${c.user.login} replied in a review thread: ${c.html_url}`,
            })
        break
      case 'review_requested':
        if (e.actor && e.created_at && e.requested_reviewer?.login === viewer)
          out.push({
            id: `q${e.id}`,
            at: iso(e.created_at),
            who: e.actor,
            line: `${e.actor.login} requested your review`,
            immediate: true,
          })
        break
    }
  }
  return out
}

const ghPrActivity: BundledWatcher = {
  meta: {
    name: 'gh-pr-activity',
    description:
      'Fires when the other side of a pull request review responds, your review is re-requested, or the PR closes. Reads GitHub as you, with the token `gh auth token` prints.',
    args: {
      pr: { required: true, description: 'owner/repo#123 or a pull request URL' },
      from: {
        description:
          'Whose activity counts: "author" (the PR author) or "others" (anyone but you). Defaults to the author when you are reviewing, and to others on your own PR.',
      },
      since: {
        description: 'An ISO time to count activity from on the first run; defaults to now.',
      },
    },
  },
  async run(ctx, args, prevState) {
    const { repo, number } = parsePr(args.pr)
    if (args.from && args.from !== 'author' && args.from !== 'others')
      throw new PermanentWatcherError('from must be "author" or "others"')
    if (args.since && Number.isNaN(Date.parse(args.since)))
      throw new PermanentWatcherError(`since must be a date and time, not "${args.since}"`)
    const prev = prevState as State | undefined
    const read = `Read it with \`gh pr view ${number} --repo ${repo} --comments\` and \`gh pr diff ${number} --repo ${repo}\`.`

    const viewer = await viewerOf(ctx)
    const pr = await getJson<Pr>(ctx, `/repos/${repo}/pulls/${number}`)
    const all = activities(await timeline(ctx, repo, number), viewer)

    const from = args.from ?? (pr.user.login === viewer ? 'others' : 'author')
    const counts = (who: Login) =>
      who.type !== 'Bot' &&
      who.login !== viewer &&
      (from === 'others' || who.login === pr.user.login)
    const start = iso(args.since ?? new Date().toISOString())
    const seen = new Set(prev?.seen ?? all.filter((a) => a.at <= start).map((a) => a.id))
    const fresh = all.filter((a) => !seen.has(a.id) && (a.immediate || counts(a.who)))
    const pushed =
      prev && pr.head.sha !== prev.headSha && from === 'author'
        ? [`New commits were pushed; the head is now ${pr.head.sha.slice(0, 7)}.`]
        : []
    const pending = [...(prev?.pending ?? []), ...fresh.map((a) => a.line), ...pushed]
    const settled = { seen: all.map((a) => a.id), headSha: pr.head.sha }

    if (pr.state === 'closed') {
      const how = pr.merged
        ? `merged${pr.merged_by ? ` by ${pr.merged_by.login}` : ''}`
        : 'closed without merging'
      return {
        fired: true,
        state: settled,
        message: [...pending, `${repo}#${number} was ${how}.`, pr.html_url].join('\n'),
      }
    }
    const waits = (prev?.waits ?? 0) + 1
    const growing = fresh.length > 0 || pushed.length > 0
    if (
      fresh.some((a) => a.immediate) ||
      (pending.length && (!growing || waits > MAX_WAITS))
    )
      return { fired: true, state: settled, message: [...pending, read].join('\n') }
    return { fired: false, state: growing ? { ...settled, pending, waits } : settled }
  },
}

export default ghPrActivity
