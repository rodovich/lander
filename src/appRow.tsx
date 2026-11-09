import { useEffect, useState } from 'react'
import { loadAppStatus } from './api'
import { startPoll } from './poll'
import type { AppStatus } from './types'

const POLL_MS = 15_000

function AppIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" role="img" aria-label="App">
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" />
        <path d="M1.8 6h12.4" />
      </g>
    </svg>
  )
}

export type AppRowState = AppStatus | null | 'unavailable'

export function AppRowView({ state }: { state: AppRowState }) {
  if (!state) return null
  const url = state !== 'unavailable' && state.listening ? state.url : undefined
  return (
    <div className="app-row">
      <AppIcon />
      {url ? (
        <a href={url} target="_blank" rel="noreferrer">
          {url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
        </a>
      ) : (
        <span>{state === 'unavailable' ? 'Status unavailable' : 'Not running'}</span>
      )}
    </div>
  )
}

export function AppRow({ slug, taskId }: { slug: string; taskId: string }) {
  const [state, setState] = useState<AppRowState>(null)

  useEffect(() => {
    let stopped = false
    const poll = startPoll(async () => {
      if (document.visibilityState === 'hidden') return
      await loadAppStatus(slug, taskId).then(
        (next) => {
          if (!stopped) setState(next)
        },
        () => {
          if (!stopped) setState((prev) => prev && 'unavailable')
        },
      )
    }, POLL_MS)
    const onShown = () => poll.runNow()
    window.addEventListener('focus', onShown)
    document.addEventListener('visibilitychange', onShown)
    return () => {
      stopped = true
      poll.stop()
      window.removeEventListener('focus', onShown)
      document.removeEventListener('visibilitychange', onShown)
    }
  }, [slug, taskId])

  return <AppRowView state={state} />
}
