import { formatTokens } from './format'
import type { TelemetryItem } from './types'

// One meter: value/max as a clamped percentage, an optional accent band, and an
// optional preformatted note under the bar. The producer owns the band ('warn')
// and the note text — this renderer only draws them.
function MeterItem({
  item,
}: {
  item: Extract<TelemetryItem, { type: 'meter' }>
}) {
  const pct = Math.max(0, Math.min(100, Math.round((item.value / item.max) * 100)))
  return (
    <div className="meter">
      <div className="meter-head">
        <span className="meter-label">{item.label}</span>
        <span className="meter-value">{pct}%</span>
      </div>
      <div
        className="meter-track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={item.label}
      >
        <div
          className={'meter-fill' + (item.level === 'warn' ? ' warn' : '')}
          style={{ width: `${pct}%` }}
        />
      </div>
      {item.note && <div className="meter-note">{item.note}</div>}
    </div>
  )
}

// A labeled number, shown abbreviated ("in 35k"). The label sits inline before the
// value, both in the muted body color the surface sets.
function CountItem({
  item,
}: {
  item: Extract<TelemetryItem, { type: 'count' }>
}) {
  return (
    <span className="telemetry-count">
      {item.label} {formatTokens(item.value)}
      {item.unit ? ` ${item.unit}` : ''}
    </span>
  )
}

// A bare string value (model name, cost). Text values are self-describing in a
// compact readout, so the label isn't shown — unlike a count, where "35k" alone
// is ambiguous. The label stays in the data to identify the item.
function TextItem({
  item,
}: {
  item: Extract<TelemetryItem, { type: 'text' }>
}) {
  return <span className="telemetry-text">{item.value}</span>
}

export function TelemetryItemView({ item }: { item: TelemetryItem }) {
  switch (item.type) {
    case 'meter':
      return <MeterItem item={item} />
    case 'count':
      return <CountItem item={item} />
    case 'text':
      return <TextItem item={item} />
  }
}

// The paneled telemetry surface (below the new-task form): a flow's items in a
// row, or nothing when the flow published none. Renders items blind — no knowledge
// of what they represent.
export function TelemetryPanel({ items }: { items: TelemetryItem[] }) {
  if (!items.length) return null
  return (
    <div className="telemetry-panel">
      <div className="telemetry-items">
        {items.map((item) => (
          <TelemetryItemView key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
}
