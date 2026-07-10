// Claude subscription-usage fetch + normalization, extracted so both sides of
// the split can read the credential and hit the OAuth endpoint: the server when
// the daemon is off, and the host daemon — which owns usage end to end (decision
// 6) once it is. Pure given the host (credential store + network); holds no task
// or server state. Types are the shared protocol ones, so the snapshot the daemon
// pushes, the server caches, and the API serves are all one shape.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { UsageWindow, UsageBody, TelemetryItem } from './protocol'

const execFileAsync = promisify(execFile)

export type { UsageWindow, UsageBody }

// The fetchUsage result: the normalized body, or an error tag. The daemon's
// refresh consumes it and keeps the last snapshot on failure (it never surfaces
// the status; the tag is retained for logging/diagnostics).
export type UsageResult =
  | { ok: true; body: UsageBody }
  | { ok: false; status: 502 | 503; error: string }

// Read the Claude Code OAuth access token the same way the CLI stores it: from
// the macOS keychain under "Claude Code-credentials", falling back to the
// ~/.claude/.credentials.json file used on Linux. Returns null if neither is
// available (e.g. API-key auth), which the daemon treats as no snapshot to push.
export async function readOAuthToken(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w',
    ])
    const token = JSON.parse(stdout)?.claudeAiOauth?.accessToken
    if (typeof token === 'string' && token) return token
  } catch {
    // not on macOS, or no keychain entry — try the file fallback
  }
  try {
    const raw = await readFile(
      path.join(os.homedir(), '.claude', '.credentials.json'),
      'utf8',
    )
    const token = JSON.parse(raw)?.claudeAiOauth?.accessToken
    if (typeof token === 'string' && token) return token
  } catch {
    // no credentials file either
  }
  return null
}

// Coerce a reset moment to an ISO string. The OAuth usage endpoint returns it
// as an ISO 8601 string (e.g. "2026-06-26T03:00:00.694553+00:00"), which we
// pass through unchanged. Older/alternate shapes may carry a Unix epoch
// (seconds) instead — the statusline feeds that straight to `date -r` — so a
// bare number (or all-digit string) is treated as seconds-since-epoch.
export function toIso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v))
    return new Date(v * 1000).toISOString()
  if (typeof v === 'string' && v)
    return /^\d+$/.test(v) ? new Date(Number(v) * 1000).toISOString() : v
  return null
}

// Normalize one window of the usage payload. Mirrors the fields the statusline
// reads (`used_percentage`, `resets_at`); `utilization` is the 0-100 percentage.
// The shape isn't a stable public API, so older spellings are tolerated too.
export function pickWindow(obj: unknown): UsageWindow | null {
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const raw = o.used_percentage ?? o.utilization ?? o.percent ?? 0
  const utilization = typeof raw === 'number' ? raw : Number(raw)
  return {
    utilization: Number.isFinite(utilization) ? utilization : 0,
    resetsAt: toIso(o.resets_at ?? o.resetsAt ?? o.reset_at ?? o.reset),
  }
}

// Reset-time formatting for the usage meters' notes. Twins of the browser copies
// in src/format.ts (formatResetTime / formatResetWhen) — the note is preformatted
// here so the meter carries a ready display string and the UI never learns it is a
// reset time. Kept in sync by hand, like the shared protocol types.
function formatResetTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // The upstream reset moment jitters around its true boundary, so round to the
  // nearest minute rather than truncating (avoids the 2:59 ↔ 3:00 flicker).
  d.setSeconds(d.getSeconds() + 30)
  d.setSeconds(0, 0)
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatResetWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  return sameDay
    ? formatResetTime(iso)
    : d.toLocaleDateString([], { weekday: 'short' })
}

// Map a Claude usage snapshot to the generic telemetry items the status panel
// renders: the session (5-hour) and weekly windows as two meters, each with a
// 'warn' band at ≥90% and a preformatted "resets …" note (session as a clock time,
// weekly as clock-if-today-else-weekday). This is Claude-flow knowledge — the codex
// path publishes no items at all, so its panel stays empty.
export function usageTelemetry(body: UsageBody): TelemetryItem[] {
  const meter = (
    id: string,
    label: string,
    w: UsageWindow,
    reset: string,
  ): TelemetryItem => {
    const pct = Math.max(0, Math.min(100, Math.round(w.utilization)))
    return {
      id,
      label,
      type: 'meter',
      value: w.utilization,
      max: 100,
      level: pct >= 90 ? 'warn' : 'ok',
      note: reset ? `resets ${reset}` : undefined,
    }
  }
  const items: TelemetryItem[] = []
  if (body.session)
    items.push(
      meter(
        'session',
        'Session',
        body.session,
        body.session.resetsAt ? formatResetTime(body.session.resetsAt) : '',
      ),
    )
  if (body.weekly)
    items.push(
      meter(
        'weekly',
        'Weekly',
        body.weekly,
        body.weekly.resetsAt ? formatResetWhen(body.weekly.resetsAt) : '',
      ),
    )
  return items
}

// Fetch the current subscription usage straight from the OAuth endpoint. Returns
// the normalized body, or an error tag the daemon's refresh logs and shrugs off.
export async function fetchUsage(): Promise<UsageResult> {
  const token = await readOAuthToken()
  if (!token)
    return { ok: false, status: 503, error: 'no Claude OAuth token available' }
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    })
    if (!res.ok)
      return {
        ok: false,
        status: 502,
        error: `usage endpoint returned ${res.status}`,
      }
    const data = (await res.json()) as Record<string, unknown>
    // The statusline reads `.rate_limits.{five_hour,seven_day}`; tolerate the
    // windows living at the top level too in case the endpoint differs.
    const rl = (data.rate_limits as Record<string, unknown> | undefined) ?? data
    return {
      ok: true,
      body: {
        session: pickWindow(rl.five_hour ?? rl.fiveHour ?? rl.session),
        weekly: pickWindow(rl.seven_day ?? rl.sevenDay ?? rl.weekly),
      },
    }
  } catch (e) {
    return {
      ok: false,
      status: 502,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
