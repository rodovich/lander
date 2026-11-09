import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRowView, type AppRowState } from './appRow'
import type { ManagedApp } from './types'

const html = (state: AppRowState) => renderToStaticMarkup(<AppRowView state={state} />)

const managed = (over: Partial<ManagedApp>): ManagedApp => ({
  phase: 'running',
  everListened: true,
  elapsedMs: 42_000,
  remainingMs: 72 * 60_000,
  held: false,
  logPath: '/logs/t1.log',
  ...over,
})

const URL = 'http://localhost:3860/'

describe('AppRowView', () => {
  it('renders nothing for a project with no app', () => {
    expect(html(null)).toBe('')
  })

  it('links to a listening app, without the scheme in its text', () => {
    const row = html({ url: URL, listening: true, canStart: false })
    expect(row).toContain('href="http://localhost:3860/"')
    expect(row).toContain('>localhost:3860</a>')
  })

  it('does not offer Start or claim anything while checking', () => {
    const row = html('checking')
    expect(row).toContain('app-row')
    expect(row).not.toContain('Start')
    expect(row).not.toContain('Not running')
  })

  it('offers no Start while something else is serving the app', () => {
    expect(html({ url: URL, listening: true, canStart: true })).not.toContain('>Start<')
  })

  it.each([
    [{ url: URL, listening: false, canStart: false }],
    [{ listening: false, canStart: false }],
  ])('says the app is not running for %j', (state) => {
    const row = html(state)
    expect(row).toContain('>Not running<')
    expect(row).not.toContain('<a ')
  })

  it('offers Start when a start command is configured', () => {
    const row = html({ listening: false, canStart: true })
    expect(row).toContain('>Start<')
    expect(row).not.toContain('Not running')
  })

  it('shows elapsed time while starting', () => {
    const row = html({ url: URL, listening: false, canStart: true, managed: managed({ phase: 'starting' }) })
    expect(row).toContain('Starting… 42s')
    expect(row).toContain('aria-label="App actions"')
  })

  it('keeps a running app’s actions behind a menu', () => {
    const row = html({ url: URL, listening: true, canStart: true, managed: managed({}) })
    expect(row).toContain('aria-label="App actions"')
    expect(row).not.toContain('>Stop<')
  })

  it('shows the time left only when it is short', () => {
    const state = (remainingMs: number) => ({
      url: URL,
      listening: true,
      canStart: true,
      managed: managed({ remainingMs }),
    })
    expect(html(state(72 * 60_000))).not.toContain('m)')
    expect(html(state(10 * 60_000))).toContain('(10m)')
  })

  it('hides the time left while the task is mid-ride', () => {
    const row = html({
      url: URL,
      listening: true,
      canStart: true,
      managed: managed({ remainingMs: 2 * 60_000, held: true }),
    })
    expect(row).not.toContain('m)')
  })

  it('distinguishes a failed start from an app that exited later', () => {
    const state = (everListened: boolean) => ({
      listening: false,
      canStart: true,
      managed: managed({ phase: 'failed', everListened }),
    })
    expect(html(state(false))).toContain('Failed to start')
    expect(html(state(false))).toContain('Try again')
    expect(html(state(true))).toContain('>Exited<')
  })

  it('offers recovery when an app stops responding', () => {
    const row = html({
      url: URL,
      listening: false,
      canStart: true,
      managed: managed({ phase: 'not-responding' }),
    })
    expect(row).toContain('Not responding')
    expect(row).toContain('aria-label="App actions"')
  })

  it('says so when the daemon cannot answer', () => {
    expect(html('unavailable')).toContain('>Status unavailable<')
  })
})
