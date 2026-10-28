// A diagnostic benchmark for the conversation renderer on long messages, such
// as the 287KB pasted log in task AseVQXEokF.
//
// It profiles the Markdown render over the real messages of a chosen task, and
// then runs synthetic scaling sweeps that double prose and pasted logs to
// reveal whether cost grows linearly or super-linearly.
//
// Run it against a task with a long message:
//   npm run bench:markdown -- data/Users-rodovich-code-lander/archived/AseVQXEokF.json
// or with no arg to run only the synthetic scaling sweeps.
//
// It is a standalone diagnostic, not part of `npm test`; it renders through
// react-dom/server (no DOM needed), matching how the unit tests exercise the
// renderer.

import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from '../src/markdown'
import type { TaskLinkResolver } from '../src/markdown'

// A resolver that never matches (mirrors the common case: message text rarely
// contains a real task id). Crucially it is still *present*, so the renderer
// runs the task-mention pass and calls back for every 8–10 char token.
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
  renderNoLinkMs: number
  renderWithLinkMs: number
}

function profile(label: string, text: string): Row {
  const chars = text.length
  // Rendering with vs. without the resolver isolates the task-mention pass.
  const renderNoLinkMs = timeMedian(() =>
    void renderToStaticMarkup(<Markdown text={text} />),
  )
  const renderWithLinkMs = timeMedian(() =>
    void renderToStaticMarkup(<Markdown text={text} linkTask={linkTask} />),
  )
  return { label, chars, renderNoLinkMs, renderWithLinkMs }
}

function printTable(rows: Row[]) {
  console.table(
    rows.map((r) => ({
      what: r.label,
      chars: r.chars,
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
    items: { kind: string; role?: string; text?: string }[]
  }
  const messages = task.items.filter((it) => it.kind === 'message')
  console.log(`\n=== ${task.title ?? taskPath} ===`)
  console.log(`${messages.length} messages\n`)
  const rows: Row[] = []
  messages.forEach((m, i) => {
    const text = m.text ?? ''
    // Skip trivial/empty messages; they're noise in the table.
    if (text.length < 200) return
    rows.push(profile(`#${i} ${m.role} (${text.length}c)`, text))
  })
  if (rows.length) printTable(rows)
  else console.log('(no message text over 200 chars)')

  const totalRender = rows.reduce((n, r) => n + r.renderWithLinkMs, 0)
  console.log(
    `\nRendering every long message once, as opening the task does: ${totalRender.toFixed(1)} ms of markdown work.`,
  )
}

// ---- Synthetic scaling sweep ------------------------------------------------
//
// Build prose out of ordinary 8–10 char words, each of which the task-mention
// pass offers to the resolver, then double the length repeatedly. A growth
// factor well above 2× per doubling means cost is super-linear in message
// length.

const WORD = 'rendering diagnosis notebooks timelines resolved '
function prose(chars: number): string {
  let s = ''
  while (s.length < chars) s += WORD
  return s.slice(0, chars)
}

function scalingSweep(title: string, inputs: { label: string; text: string }[]) {
  console.log(`\n=== ${title} ===`)
  const rows = inputs.map(({ label, text }) => profile(label, text))
  printTable(rows)
  console.log('\nPer-doubling growth of render+linkTask time (×2 length each step):')
  for (let i = 1; i < rows.length; i++) {
    const factor = rows[i].renderWithLinkMs / rows[i - 1].renderWithLinkMs
    const verdict =
      factor > 2.5 ? '  <-- SUPER-LINEAR (hotspot)' : factor < 1.8 ? '  (sub-linear)' : ''
    console.log(
      `  ${rows[i - 1].chars}c -> ${rows[i].chars}c: ${factor.toFixed(2)}×${verdict}`,
    )
  }
}

scalingSweep(
  'Synthetic scaling sweep (prose of 8+ char words)',
  [2000, 4000, 8000, 16000, 32000].map((n) => ({ label: `prose ${n}c`, text: prose(n) })),
)

const logLine = 'at resolveBaseSync (file:///Users/x/node_modules/tsx/register.mjs:2:8745)'
scalingSweep(
  'Synthetic scaling sweep (pasted log)',
  [875, 1750, 3500, 7000].map((lines) => ({
    label: `log ${lines} lines`,
    text: Array.from({ length: lines }, () => logLine).join('\n'),
  })),
)
