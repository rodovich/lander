import { useEffect, useId, useRef, useState } from 'react'
import { taskUsageSummary, usageBreakdown } from './taskMeta'
import { TelemetryItemView } from './telemetry'
import type { Task } from './types'

// The usage readout in the composer's corner: a summary line — provider &
// model, the task's working time, its cost — that opens the full breakdown on
// hover or tap.
//
// The breakdown is real DOM rather than a `title` attribute, which is what lets
// it be a table: the turn and the task read down two columns, so comparing them
// is a glance rather than the toggling the summary used to require. Everything
// it shows is derived by `usageBreakdown`; this renders strings.
export function UsageReadout({ task }: { task: Task }) {
  const items = taskUsageSummary(task)
  // Hover and tap open the same panel but hold it open on different terms: a
  // pointer's is over as soon as it leaves, while a tap's has to stay up until
  // something dismisses it. Keeping them apart means neither closes the other's.
  const [hovered, setHovered] = useState(false)
  const [pinned, setPinned] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!pinned) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPinned(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [pinned])

  if (!items) return null
  const open = hovered || pinned
  const { groups, cacheMiss } = usageBreakdown(task)
  return (
    // Hover is tracked on the whole readout, panel included, so a pointer that
    // reaches the table doesn't dismiss it: a leave event ignores the element's
    // own descendants, and the panel is one. It has to *reach* it, though —
    // the panel stands off the summary, and crossing that gap is a leave. A
    // click pins the panel open for anyone who wants to dwell on it.
    <div
      className="usage-readout"
      ref={ref}
      // Hover is for pointers that have one. A touch's synthetic enter would
      // otherwise open the panel just as the tap that follows it toggles the
      // pin, leaving the two to cancel out.
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') setHovered(true)
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === 'mouse') setHovered(false)
      }}
    >
      <button
        type="button"
        className="usage-summary"
        aria-expanded={open}
        // Only while the panel is in the DOM: a reference to an element that
        // isn't there is worse than none.
        aria-controls={open ? panelId : undefined}
        onClick={() => setPinned((p) => !p)}
      >
        {items.map((item) => (
          <TelemetryItemView key={item.id} item={item} />
        ))}
      </button>
      {open && (
        <div className="usage-details" id={panelId}>
          <table className="usage-table">
            <thead>
              <tr>
                {/* The label column's header is the empty corner cell every
                    two-way table has. */}
                <td />
                <th scope="col">turn</th>
                <th scope="col">total</th>
              </tr>
            </thead>
            {/* One row group per band of the breakdown; the stylesheet sets
                the bands apart with a gap rather than a rule. */}
            {groups.map((rows) => (
              <tbody key={rows[0].id}>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <th scope="row">{r.label}</th>
                    <td>{r.turn}</td>
                    <td>{r.total}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
          {cacheMiss && <div className="usage-note">{cacheMiss}</div>}
        </div>
      )}
    </div>
  )
}
