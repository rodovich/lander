import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PermanentWatcherError, type WatcherCtx } from './types'

const execFileAsync = promisify(execFile)

export type Login = { login: string; type?: string }

export type TimelineEvent = {
  event: string
  id?: number | string
  actor?: Login
  user?: Login
  created_at?: string
  submitted_at?: string
  state?: string
  html_url?: string
  requested_reviewer?: Login
  requested_team?: { slug: string }
  comments?: { id: number; user?: Login; created_at?: string; html_url?: string }[]
}

export type GitHub = {
  get(path: string, opts: { signal: AbortSignal }): Promise<{ body: unknown }>
}

type GitHubCtx = Pick<WatcherCtx, 'github' | 'signal'>

// GitHub's times have no milliseconds and ours do, so every time is put in one
// form before times are compared as strings.
export function iso(time: string): string {
  return new Date(time).toISOString()
}

export async function getJson<T>(ctx: GitHubCtx, path: string): Promise<T> {
  return (await ctx.github.get(path, { signal: ctx.signal })).body as T
}

export async function viewer(ctx: GitHubCtx): Promise<string> {
  return (await getJson<Login>(ctx, '/user')).login
}

export async function timeline(
  ctx: GitHubCtx,
  repo: string,
  number: number,
): Promise<TimelineEvent[]> {
  const events: TimelineEvent[] = []
  for (let page = 1; ; page++) {
    const batch = await getJson<TimelineEvent[]>(
      ctx,
      `/repos/${repo}/issues/${number}/timeline?per_page=100&page=${page}`,
    )
    events.push(...batch)
    if (batch.length < 100) return events
  }
}

async function ghToken(): Promise<string> {
  const token = (await execFileAsync('gh', ['auth', 'token'], { timeout: 10_000 })).stdout.trim()
  if (!token) throw new Error('gh auth token printed no token')
  return token
}

// GitHub's REST API as the user, with the token `gh` already holds. The token
// is kept until GitHub refuses it or fetching it fails, then fetched again.
export function createGitHub(token: () => Promise<string> = ghToken): GitHub {
  let cached: Promise<string> | undefined
  const request = async (path: string, opts: { signal: AbortSignal }) => {
    const pending = (cached ??= token())
    let auth: string
    try {
      auth = await pending
    } catch (e) {
      if (cached === pending) cached = undefined
      throw e
    }
    return fetch(`https://api.github.com${path}`, {
      signal: opts.signal,
      headers: {
        authorization: `Bearer ${auth}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    })
  }
  return {
    async get(path, opts) {
      let res = await request(path, opts)
      if (res.status === 401) {
        cached = undefined
        res = await request(path, opts)
      }
      if (res.status === 404)
        throw new PermanentWatcherError(`GitHub has no ${path}, or you can't see it`)
      if (res.status !== 200) throw new Error(`GitHub answered ${res.status} for ${path}`)
      return { body: await res.json() }
    },
  }
}
