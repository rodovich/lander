// A diagnostic benchmark for the conversation renderer's known sore spot: a
// single very long user message (e.g. task AseVQXEokF, whose UI is sluggish).
//
// It profiles the two halves of the markdown pipeline — parseBlocks (block
// splitting) and the full Markdown render (blocks + inline spans → React
// elements) — over the real messages of a chosen task, and then runs a synthetic
// scaling sweep that doubles a prose message's length to reveal whether cost
// grows linearly or super-linearly.
//
// Run it against the sluggish task:
//   npm run bench:markdown -- data/Users-rodovich-code-lander/tasks/AseVQXEokF.json
// or with no arg to run only the synthetic scaling sweep.
//
// It is a standalone diagnostic, not part of `npm test`; it renders through
// react-dom/server (no DOM needed), matching how the unit tests exercise the
// renderer.

import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown, parseBlocks } from '../src/markdown'
import type { TaskLinkResolver } from '../src/markdown'

// A resolver that never matches (mirrors the common case: message text rarely
// contains a real task id). Crucially it is still *present*, so the renderer
// activates the task-mention regex and calls back for every 8–21 char token —
// which is where a long prose message spends most of its time.
const linkTask: TaskLinkResolver = () => undefined

function ms(fn: () => void, iters = 1): number {
  const t0 = performance.now()
  for (let i = 0; i < iters; i++) fn()
  return (performance.now() - t0) / iters
}

// Median of a few runs so a single GC pause doesn't dominate a small sample.
function timeMedian(fn: () => void, runs = 5): number {
  const samples = Array.from({ length: runs }, () => ms(fn))
  samples.sort((a, b) => a - b)
  return samples[Math.floor(runs / 2)]
}

type Row = {
  label: string
  chars: number
  parseMs: number
  renderNoLinkMs: number
  renderWithLinkMs: number
}

function profile(label: string, text: string): Row {
  const chars = text.length
  // parseBlocks is pure (no React); render includes parse + inline + element
  // construction. Rendering with vs. without the resolver isolates the
  // task-mention regex's contribution.
  const parseMs = timeMedian(() => void parseBlocks(text))
  const renderNoLinkMs = timeMedian(() =>
    void renderToStaticMarkup(<Markdown text={text} />),
  )
  const renderWithLinkMs = timeMedian(() =>
    void renderToStaticMarkup(<Markdown text={text} linkTask={linkTask} />),
  )
  return { label, chars, parseMs, renderNoLinkMs, renderWithLinkMs }
}

function printTable(rows: Row[]) {
  console.table(
    rows.map((r) => ({
      what: r.label,
      chars: r.chars,
      'parse (ms)': +r.parseMs.toFixed(2),
      'render, no link (ms)': +r.renderNoLinkMs.toFixed(2),
      'render, +linkTask (ms)': +r.renderWithLinkMs.toFixed(2),
      'linkTask overhead ×':
        r.renderNoLinkMs > 0
          ? +(r.renderWithLinkMs / r.renderNoLinkMs).toFixed(1)
          : '—',
    })),
  )
}

// ---- Real task messages -----------------------------------------------------

const taskPath = process.argv[2]
if (taskPath) {
  const task = JSON.parse(readFileSync(taskPath, 'utf8')) as {
    title?: string
    messages: { role: string; text?: string }[]
  }
  console.log(`\n=== ${task.title ?? taskPath} ===`)
  console.log(`${task.messages.length} messages\n`)
  const rows: Row[] = []
  task.messages.forEach((m, i) => {
    const text = m.text ?? ''
    // Skip trivial/empty messages; they're noise in the table.
    if (text.length < 200) return
    rows.push(profile(`#${i} ${m.role} (${text.length}c)`, text))
  })
  if (rows.length) printTable(rows)
  else console.log('(no message text over 200 chars)')

  // The 2s poll re-renders the whole open conversation from scratch. Sum the
  // per-render cost of every message to see one full re-render's markdown cost.
  const totalRender = rows.reduce((n, r) => n + r.renderWithLinkMs, 0)
  console.log(
    `\nOne full re-render of all long messages: ${totalRender.toFixed(1)} ms of markdown work.`,
  )
  console.log(
    `At the 2s poll cadence that recurs ~${(totalRender / 2000 * 100).toFixed(1)}% of a frame budget every 2s,`,
  )
  console.log(
    `and every scroll event (setAtBottom) / tab-focus change triggers the same full re-render.`,
  )
}

// ---- Synthetic scaling sweep ------------------------------------------------
//
// Build prose out of ordinary 8+ char words (the length that trips the
// task-mention regex `[0-9A-Za-z_-]{8,21}`), then double the length repeatedly.
// If render-with-linkTask time more than doubles per doubling, cost is
// super-linear in message length — the signature of the per-token rescan in
// renderInline.

const WORD = 'diagnostics performance rendering conversation instrumentation '
function prose(chars: number): string {
  let s = ''
  while (s.length < chars) s += WORD
  return s.slice(0, chars)
}

console.log('\n=== Synthetic scaling sweep (prose of 8+ char words) ===')
const sweep = [2000, 4000, 8000, 16000, 32000].map((n) =>
  profile(`prose ${n}c`, prose(n)),
)
printTable(sweep)

console.log('\nPer-doubling growth of render+linkTask time (×2 length each step):')
for (let i = 1; i < sweep.length; i++) {
  const factor = sweep[i].renderWithLinkMs / sweep[i - 1].renderWithLinkMs
  const verdict =
    factor > 2.5 ? '  <-- SUPER-LINEAR (hotspot)' : factor < 1.8 ? '  (sub-linear)' : ''
  console.log(
    `  ${sweep[i - 1].chars}c -> ${sweep[i].chars}c: ${factor.toFixed(2)}×${verdict}`,
  )
}
