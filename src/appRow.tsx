import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { loadAppLog, loadAppStatus, postAppAction, touchApp } from './api'
import { AppIcon } from './appIcon'
import { CopyButton } from './copyButton'
import { formatDuration } from './format'
import { KebabMenu, type MenuItem } from './menus'
import { startPoll, type Poll } from './poll'
import type { AppAction, AppStatus, ManagedApp } from './types'

const TICK_MS = 1_000
const POLL_MS = 15_000
const SHOW_TIME_LEFT_MS = 30 * 60_000

export type AppRowState = AppStatus | null | 'unavailable' | 'checking'

// Projects last seen to have an app, so that opening one of their tasks holds
// the row's place until its status arrives.
const projectsWithApp = new Set<string>()

const managedOf = (state: AppRowState): ManagedApp | undefined =>
  typeof state === 'object' ? state?.managed : undefined

const minutesLeft = (ms: number) => Math.ceil(Math.max(0, ms) / 60_000)

function Action({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="app-action" onClick={onClick}>
      {label}
    </button>
  )
}

function AppLink({ url, onOpen }: { url: string; onOpen?: () => void }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" onClick={onOpen}>
      {url.replace(/^https?:\/\//, '').replace(/\/$/, '')}
    </a>
  )
}

export function AppRowView({
  state,
  error,
  onAction = () => {},
  onViewLog = () => {},
  onOpen,
}: {
  state: AppRowState
  error?: string
  onAction?: (action: AppAction) => void
  onViewLog?: () => void
  onOpen?: () => void
}) {
  if (!state) return null

  const menu = (
    <KebabMenu
      label="App actions"
      items={[
        { key: 'restart', label: 'Restart', onSelect: () => onAction('restart') },
        { key: 'stop', label: 'Stop', onSelect: () => onAction('stop') },
        { key: 'log', label: 'View log', onSelect: onViewLog },
      ] satisfies MenuItem[]}
    />
  )

  function content(status: AppStatus) {
    const { managed, url, listening, canStart } = status
    if (managed?.phase === 'starting')
      return (
        <>
          <span>Starting… {formatDuration(managed.elapsedMs)}</span>
          {menu}
        </>
      )
    if (managed?.phase === 'stopping') return <span>Stopping…</span>
    if (managed?.phase === 'failed')
      return (
        <>
          <span className="app-error">{managed.everListened ? 'Exited' : 'Failed to start'}</span>
          <Action label="Try again" onClick={() => onAction('restart')} />
          <Action label="View log" onClick={onViewLog} />
        </>
      )
    if (managed?.phase === 'not-responding')
      return (
        <>
          <span className="app-error">Not responding</span>
          {menu}
        </>
      )
    if (managed && url)
      return (
        <>
          <AppLink url={url} onOpen={onOpen} />
          {!managed.held && managed.remainingMs <= SHOW_TIME_LEFT_MS && (
            <span>({minutesLeft(managed.remainingMs)}m)</span>
          )}
          {menu}
        </>
      )
    if (listening && url) return <AppLink url={url} />
    return canStart ? (
      <Action label="Start" onClick={() => onAction('start')} />
    ) : (
      <span>Not running</span>
    )
  }

  return (
    <div className="app-row">
      <AppIcon />
      {state === 'unavailable' ? (
        <span>Status unavailable</span>
      ) : state === 'checking' ? null : (
        content(state)
      )}
      {error && <span className="app-error">{error}</span>}
    </div>
  )
}

function AppLogModal({
  text,
  path,
  onClose,
}: {
  text: string
  path?: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="attachment-preview-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="attachment-preview-modal" role="dialog" aria-modal="true" aria-label="App log">
        <div className="attachment-preview-head">
          <div className="attachment-preview-heading">
            <span className="attachment-preview-name">App log</span>
          </div>
          <button
            type="button"
            className="attachment-preview-close"
            aria-label="Close log"
            title="Close log"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="attachment-preview-text-wrap">
          <pre className="attachment-preview-text">{text || 'No output yet.'}</pre>
        </div>
        <div className="attachment-preview-foot">
          <span className="attachment-preview-meta">{path}</span>
          {path && <CopyButton text={path} label="Copy log path" className="title-action" size={13} />}
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function AppRow({ slug, taskId }: { slug: string; taskId: string }) {
  const initial: AppRowState = projectsWithApp.has(slug) ? 'checking' : null
  const [state, setState] = useState<AppRowState>(initial)
  const [log, setLog] = useState<string>()
  const [error, setError] = useState<string>()
  const stateRef = useRef<AppRowState>(initial)
  const pollRef = useRef<Poll>(undefined)
  // Bumped by each action, so a poll that began before it can't overwrite it.
  const generationRef = useRef(0)
  const busyRef = useRef(false)

  function show(next: AppRowState) {
    stateRef.current = next
    setState(next)
    if (next === null) projectsWithApp.delete(slug)
    else if (next !== 'unavailable') projectsWithApp.add(slug)
  }

  useEffect(() => {
    let stopped = false
    const transient = () => {
      const phase = managedOf(stateRef.current)?.phase
      return phase === 'starting' || phase === 'stopping'
    }
    const poll = startPoll(
      async () => {
        if (stopped || document.visibilityState === 'hidden') return
        const generation = generationRef.current
        await loadAppStatus(slug, taskId).then(
          (next) => {
            if (!stopped && generation === generationRef.current) show(next)
          },
          () => {
            if (!stopped && generation === generationRef.current && stateRef.current)
              show('unavailable')
          },
        )
      },
      () => (transient() ? TICK_MS : POLL_MS),
    )
    pollRef.current = poll
    // Opening or returning to the task renews its app's lease.
    touchApp(slug, taskId)
    const onShown = () => {
      poll.runNow()
      if (document.visibilityState === 'visible') touchApp(slug, taskId)
    }
    window.addEventListener('focus', onShown)
    document.addEventListener('visibilitychange', onShown)
    return () => {
      stopped = true
      poll.stop()
      window.removeEventListener('focus', onShown)
      document.removeEventListener('visibilitychange', onShown)
    }
  }, [slug, taskId])

  function viewLog() {
    loadAppLog(slug, taskId).then(setLog, (e: Error) => setError(e.message))
  }

  function act(action: AppAction) {
    if (busyRef.current) return
    busyRef.current = true
    generationRef.current++
    setError(undefined)
    postAppAction(slug, taskId, action)
      .then(
        (next) => {
          generationRef.current++
          show(next)
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => {
        busyRef.current = false
        pollRef.current?.runNow()
      })
  }

  return (
    <>
      <AppRowView
        state={state}
        error={error}
        onAction={act}
        onViewLog={viewLog}
        onOpen={() => touchApp(slug, taskId)}
      />
      {log !== undefined && (
        <AppLogModal text={log} path={managedOf(state)?.logPath} onClose={() => setLog(undefined)} />
      )}
    </>
  )
}
