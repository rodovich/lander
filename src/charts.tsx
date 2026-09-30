import { useEffect, useId, useRef, useState } from 'react'

// Chart components that draw generic shapes — series, columns of values, a
// grid of counts — and know nothing about what the numbers count. The caller
// names the series, picks their colors, and says how a readout words them.

// How a hover readout words a series beside its number: "1 turn", "3 turns".
export type Noun = { one: string; other: string }

export type ChartSeries = {
  key: string
  // The legend's label, and the readout's word when `readout` is absent.
  label: string
  readout?: Noun
}

// One bar's worth: its axis label, the fuller name its tooltip leads with, one
// value per series — or null for a column with nothing to show, which draws
// no bar and answers no hover — and whether its period is still in progress,
// which is hatched.
export type BarColumn = {
  key: string | number
  label: string
  title: string
  partial: boolean
  values: number[] | null
}

export type BarData = { series: ChartSeries[]; columns: BarColumn[] }

// Counts on a weekday × hour grid: seven rows, Sunday first, of 24 hours.
export type HeatGrid = { cells: number[][]; max: number }

// A series' color, by the series and its index in the chart's series list.
export type SeriesColor = (series: ChartSeries, index: number) => string

const PLOT_HEIGHT = 150
const AXIS_LEFT = 36
const AXIS_BOTTOM = 22
const PLOT_TOP = 8
const MAX_BAR = 24
const GAP = 2
// The share of a column's slot its bars may fill; the rest is air.
const BAR_FILL = 0.7

// A heatmap's nonzero shades: its color mixed into the page at rising
// strengths.
const HEAT_SHADES = [20, 40, 60, 80, 100]
const HEAT_EMPTY = 'var(--bg-tinted)'
const shade = (color: string, percent: number) =>
  `color-mix(in srgb, ${color} ${percent}%, var(--bg))`

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

// The width a chart has to draw in, tracked as its container resizes.
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.floor(entry.contentRect.width)),
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

// A tick step of 1, 2, or 5 times a power of ten that splits `max` into about
// four intervals.
export function niceStep(max: number): number {
  if (max <= 0) return 1
  const raw = max / 4
  const power = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw)!
}

// Which shade a count takes: -1 (empty) for zero, otherwise one of the
// nonzero shades by its share of the busiest cell.
export function heatStep(count: number, max: number): number {
  if (count <= 0 || max <= 0) return -1
  return Math.min(HEAT_SHADES.length - 1, Math.ceil((count / max) * HEAT_SHADES.length) - 1)
}

// A readout's number and word. Readouts are whole numbers; the bars carry the
// precision.
export function readout(value: number, series: ChartSeries): [string, string] {
  const n = Math.round(value)
  const word = series.readout
    ? n === 1
      ? series.readout.one
      : series.readout.other
    : series.label
  return [n.toLocaleString(), word]
}

const formatTick = (v: number) =>
  v.toLocaleString(undefined, { maximumFractionDigits: 1 })

// A bar with a rounded data end and a square foot on the baseline.
function barPath(x: number, y: number, w: number, h: number, rounded: boolean) {
  const r = rounded ? Math.min(4, h, w / 2) : 0
  return (
    `M${x},${y + h}V${y + r}` +
    (r ? `Q${x},${y} ${x + r},${y}` : '') +
    `H${x + w - r}` +
    (r ? `Q${x + w},${y} ${x + w},${y + r}` : '') +
    `V${y + h}Z`
  )
}

// The key under a chart: a swatch and a label per entry.
function Legend({ entries }: { entries: { key: string; label: string; color: string }[] }) {
  return (
    <ul className="chart-legend">
      {entries.map((e) => (
        <li key={e.key} className="chart-legend-item">
          <span className="chart-swatch" style={{ background: e.color }} />
          {e.label}
        </li>
      ))}
    </ul>
  )
}

// The hover readout over a chart: centered on `x`, held inside the chart's
// width, each row a number, its word, and optionally a stroke of its color.
export function ChartTooltip({
  x,
  top,
  width,
  title,
  rows,
}: {
  x: number
  top?: number
  width: number
  title: string
  rows: { key: string; color?: string; value: string; word: string }[]
}) {
  const inset = 80
  return (
    <div
      className="chart-tooltip"
      style={{ left: Math.min(Math.max(x, inset), Math.max(inset, width - inset)), top }}
    >
      <div className="chart-tooltip-title">{title}</div>
      {rows.map((row) => (
        <div key={row.key} className="chart-tooltip-row">
          {row.color !== undefined && (
            <span className="chart-tooltip-key" style={{ background: row.color }} />
          )}
          <strong>{row.value}</strong>
          <span className="chart-tooltip-word">{row.word}</span>
        </div>
      ))}
    </div>
  )
}

// A column chart over a run of periods. `stacked` piles each column's series
// into one bar; `grouped` sets them side by side. A single series draws the
// same either way.
export function BarChart({
  title,
  data,
  color,
  layout = 'stacked',
}: {
  title: string
  data: BarData
  color: SeriesColor
  layout?: 'stacked' | 'grouped'
}) {
  const [wrapRef, width] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const id = useId()
  const { series, columns } = data
  const colors = series.map((s, i) => color(s, i))
  const stacked = layout === 'stacked'

  // Only the series with something in view get a legend entry, a readout row,
  // and a slot in a grouped column; each keeps its color either way.
  const indexed = series.map((s, i) => ({ ...s, i }))
  const present = indexed.filter(({ i }) => columns.some((c) => c.values && c.values[i] > 0))
  const shown = present.length ? present : indexed

  const plotW = Math.max(0, width - AXIS_LEFT)
  const n = columns.length
  const slot = n ? plotW / n : 0
  const max = Math.max(
    0,
    ...columns.map(({ values: v }) =>
      v ? (stacked ? v.reduce((a, b) => a + b, 0) : Math.max(0, ...v)) : 0,
    ),
  )
  const step = niceStep(max)
  const top = Math.max(step, Math.ceil(max / step) * step)
  const ticks: number[] = []
  for (let t = 0; t <= top + step / 2; t += step) ticks.push(t)
  const y = (v: number) => PLOT_TOP + PLOT_HEIGHT - (v / top) * PLOT_HEIGHT
  const height = PLOT_TOP + PLOT_HEIGHT + AXIS_BOTTOM

  const labelEvery = Math.ceil(n / Math.max(1, Math.floor(plotW / 52)))

  const perColumn = stacked ? 1 : Math.max(1, present.length)
  const barW = Math.min(
    MAX_BAR,
    Math.max(2, (slot * BAR_FILL - GAP * (perColumn - 1)) / perColumn),
  )

  const hovered = hover === null ? null : columns[hover]
  const readoutRows = (values: number[]) => {
    const rows = shown.map((s) => {
      const [value, word] = readout(values[s.i], s)
      return { key: s.key, color: colors[s.i], value, word }
    })
    if (stacked && shown.length > 1)
      rows.push({
        key: '\0total',
        color: 'transparent',
        value: Math.round(values.reduce((a, b) => a + b, 0)).toLocaleString(),
        word: 'total',
      })
    return rows
  }

  const bar = (column: BarColumn, i: number, d: string) => (
    <path
      key={i}
      d={d}
      style={{ fill: column.partial ? `url(#${id}-hatch-${i})` : colors[i] }}
    />
  )

  return (
    <section className="chart-card">
      <h3 className="chart-title">{title}</h3>
      <div className="chart-plot" ref={wrapRef}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={title}>
            <defs>
              {series.map((s, i) => (
                <pattern
                  key={s.key}
                  id={`${id}-hatch-${i}`}
                  patternUnits="userSpaceOnUse"
                  width="6"
                  height="6"
                  patternTransform="rotate(45)"
                >
                  <rect width="6" height="6" style={{ fill: colors[i], fillOpacity: 0.3 }} />
                  <line x1="1.5" y1="0" x2="1.5" y2="6" style={{ stroke: colors[i], strokeWidth: 3 }} />
                </pattern>
              ))}
            </defs>
            {ticks.map((t) => (
              <g key={t}>
                <line
                  className={t === 0 ? 'chart-baseline' : 'chart-gridline'}
                  x1={AXIS_LEFT}
                  x2={width}
                  y1={y(t)}
                  y2={y(t)}
                />
                <text className="chart-tick" x={AXIS_LEFT - 6} y={y(t)} dy="0.32em" textAnchor="end">
                  {formatTick(t)}
                </text>
              </g>
            ))}
            {hovered?.values && (
              <rect
                className="chart-hover"
                x={AXIS_LEFT + slot * hover!}
                y={PLOT_TOP}
                width={slot}
                height={PLOT_HEIGHT}
              />
            )}
            {columns.map((column, ci) => {
              const values = column.values
              if (!values) return null
              const cx = AXIS_LEFT + slot * (ci + 0.5)
              if (stacked) {
                const topIndex = values.reduce((last, v, i) => (v > 0 ? i : last), -1)
                let base = 0
                return (
                  <g key={column.key}>
                    {values.map((v, i) => {
                      if (v <= 0) return null
                      const y0 = y(base)
                      base += v
                      const y1 = y(base)
                      // The surface gap sits under every segment but the first.
                      const h = y0 - y1 - (y0 < y(0) ? GAP : 0)
                      if (h <= 0) return null
                      return bar(column, i, barPath(cx - barW / 2, y1, barW, h, i === topIndex))
                    })}
                  </g>
                )
              }
              const groupW = perColumn * barW + GAP * (perColumn - 1)
              return (
                <g key={column.key}>
                  {present.map(({ i }, k) => {
                    const v = values[i]
                    if (v <= 0) return null
                    const x = cx - groupW / 2 + k * (barW + GAP)
                    return bar(column, i, barPath(x, y(v), barW, y(0) - y(v), true))
                  })}
                </g>
              )
            })}
            {columns.map((column, ci) =>
              (n - 1 - ci) % labelEvery === 0 ? (
                <text
                  key={column.key}
                  className="chart-tick"
                  x={AXIS_LEFT + slot * (ci + 0.5)}
                  y={PLOT_TOP + PLOT_HEIGHT + 15}
                  textAnchor="middle"
                >
                  {column.label}
                </text>
              ) : null,
            )}
            {columns.map((column, ci) => (
              <rect
                key={column.key}
                className="chart-hit"
                x={AXIS_LEFT + slot * ci}
                y={0}
                width={slot}
                height={height}
                tabIndex={column.values ? 0 : -1}
                aria-label={
                  column.values
                    ? `${column.title}: ` +
                      readoutRows(column.values)
                        .map((r) => `${r.value} ${r.word}`)
                        .join(', ')
                    : undefined
                }
                onPointerEnter={() => setHover(ci)}
                onPointerLeave={() => setHover((h) => (h === ci ? null : h))}
                onFocus={() => setHover(ci)}
                onBlur={() => setHover((h) => (h === ci ? null : h))}
              />
            ))}
          </svg>
        )}
        {hovered?.values && (
          <ChartTooltip
            x={AXIS_LEFT + slot * (hover! + 0.5)}
            width={width}
            title={hovered.title}
            rows={readoutRows(hovered.values)}
          />
        )}
      </div>
      {shown.length > 1 && (
        <Legend entries={shown.map((s) => ({ key: s.key, label: s.label, color: colors[s.i] }))} />
      )}
    </section>
  )
}

const hourLabel = (h: number) =>
  new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })

// Counts by weekday and hour, each cell shaded by its share of the busiest.
export function HeatmapChart({
  title,
  grid,
  color,
  noun,
}: {
  title: string
  grid: HeatGrid
  color: string
  // What a cell counts, as a readout words it.
  noun: Noun
}) {
  const [wrapRef, width] = useWidth()
  const [hover, setHover] = useState<{ d: number; h: number } | null>(null)
  const left = 36
  const cellW = Math.max(0, (width - left) / 24)
  const cellH = 20
  const top = 4
  const height = top + cellH * 7 + AXIS_BOTTOM
  const cellReadout = (count: number) =>
    readout(count, { key: '', label: noun.other, readout: noun })

  return (
    <section className="chart-card chart-card-wide">
      <h3 className="chart-title">{title}</h3>
      <div className="chart-plot" ref={wrapRef}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={title}>
            {WEEKDAYS.map((name, d) => (
              <g key={name}>
                <text
                  className="chart-tick"
                  x={left - 6}
                  y={top + cellH * (d + 0.5)}
                  dy="0.32em"
                  textAnchor="end"
                >
                  {name}
                </text>
                {grid.cells[d].map((c, h) => {
                  const step = heatStep(c, grid.max)
                  return (
                    <rect
                      key={h}
                      className={
                        'chart-heat-cell' + (hover?.d === d && hover.h === h ? ' hovered' : '')
                      }
                      x={left + cellW * h + 1}
                      y={top + cellH * d + 1}
                      width={Math.max(0, cellW - 2)}
                      height={cellH - 2}
                      rx="3"
                      style={{ fill: step < 0 ? HEAT_EMPTY : shade(color, HEAT_SHADES[step]) }}
                      tabIndex={0}
                      aria-label={`${name} ${hourLabel(h)}: ${cellReadout(c).join(' ')}`}
                      onPointerEnter={() => setHover({ d, h })}
                      onPointerLeave={() => setHover(null)}
                      onFocus={() => setHover({ d, h })}
                      onBlur={() => setHover(null)}
                    />
                  )
                })}
              </g>
            ))}
            {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
              <text key={h} className="chart-tick" x={left + cellW * h} y={top + cellH * 7 + 15}>
                {hourLabel(h)}
              </text>
            ))}
          </svg>
        )}
        {hover && (
          <ChartTooltip
            x={left + cellW * (hover.h + 0.5)}
            top={top + cellH * (hover.d + 1) + 4}
            width={width}
            title={`${WEEKDAYS[hover.d]}, ${hourLabel(hover.h)}–${hourLabel((hover.h + 1) % 24)}`}
            rows={(() => {
              const [value, word] = cellReadout(grid.cells[hover.d][hover.h])
              return [{ key: 'count', value, word }]
            })()}
          />
        )}
      </div>
      <div className="chart-legend">
        <span className="chart-legend-item">
          Fewer
          {HEAT_SHADES.map((p) => (
            <span key={p} className="chart-swatch" style={{ background: shade(color, p) }} />
          ))}
          More
        </span>
      </div>
    </section>
  )
}
