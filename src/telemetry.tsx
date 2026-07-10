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

function TelemetryItemView({ item }: { item: TelemetryItem }) {
  switch (item.type) {
    case 'meter':
      return <MeterItem item={item} />
    // 'text' and 'count' primitives arrive with the composer footer (Phase B).
    default:
      return null
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
