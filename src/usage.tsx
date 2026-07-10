import { formatResetTime, formatResetWhen } from './format'
import type { Task, Usage, UsageWindow } from './types'

// One labeled progress bar: a percentage of a usage window plus when it resets.
function UsageBar({
  label,
  window,
  reset,
}: {
  label: string
  window: UsageWindow
  reset: string
}) {
  const pct = Math.max(0, Math.min(100, Math.round(window.utilization)))
  // Two bands: low (landed) under 90, high (wedged) at 90 and above.
  const level = pct >= 90 ? 'high' : ''
  return (
    <div className="usage-window">
      <div className="usage-window-head">
        <span className="usage-label">{label}</span>
        <span className="usage-pct">{pct}%</span>
      </div>
      <div
        className="usage-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className={'usage-bar-fill' + (level ? ' ' + level : '')}
          style={{ width: `${pct}%` }}
        />
      </div>
      {reset && <div className="usage-reset">resets {reset}</div>}
    </div>
  )
}

// Compact Claude subscription usage shown under the new-task form: the current
// 5-hour session window and the 7-day weekly window, each a small progress bar
// with its reset time. The snapshot rides in on every tasks poll (the server
// owns when to refresh it from upstream), so this is purely presentational.
export function UsageSummary({
  usage,
  agent,
}: {
  usage: Usage | null
  agent?: Task['agent']
}) {
  if (agent === 'codex')
    return (
      <div className="usage-summary usage-unsupported">
        Codex subscription usage unsupported
      </div>
    )
  // Stay quiet until we have something to show; a missing token or endpoint
  // error leaves usage null, which shouldn't clutter the sidebar.
  if (!usage || (!usage.session && !usage.weekly)) return null

  return (
    <div className="usage-summary">
      <div className="usage-windows">
        {usage.session && (
          <UsageBar
            label="Session"
            window={usage.session}
            reset={
              usage.session.resetsAt
                ? formatResetTime(usage.session.resetsAt)
                : ''
            }
          />
        )}
        {usage.weekly && (
          <UsageBar
            label="Weekly"
            window={usage.weekly}
            reset={
              usage.weekly.resetsAt ? formatResetWhen(usage.weekly.resetsAt) : ''
            }
          />
        )}
      </div>
    </div>
  )
}
