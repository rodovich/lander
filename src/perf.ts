// A tiny, opt-in render profiler for tracking down UI sluggishness (e.g. task
// AseVQXEokF, whose very long user message makes the conversation view lag).
//
// It is OFF by default and, when off, every entry point below is a single
// boolean check — no timers, no allocations — so it is safe to leave wired into
// the render path. Turn it on live, without a rebuild, from the browser console:
//
//   landerPerf.on()      // enable, then interact with the sluggish task
//   landerPerf.report()  // print a table: count / total ms / avg / max per label
//   landerPerf.reset()   // clear accumulated stats
//   landerPerf.off()     // disable again
//
// The flag persists in localStorage, so a reload keeps profiling on. You can also
// start with ?perf=1 in the URL. `landerPerf.slow(8)` lowers the "slow render"
// console.warn threshold (default 16ms — one dropped 60fps frame) so individual
// janky measures are flagged as they happen, with the label, so you can see
// *which* work blew the frame budget while you scroll/stream.

const STORAGE_KEY = 'lander:perf'

type Stat = { count: number; total: number; max: number; maxDetail?: string }

const stats = new Map<string, Stat>()
let enabled = false
let slowMs = 16

function readInitial(): boolean {
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('perf') === '1') return true
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

// Cached so the hot path is one property read, not a storage hit per call.
enabled = readInitial()

export function perfEnabled(): boolean {
  return enabled
}

function record(label: string, ms: number, detail?: string) {
  const s = stats.get(label) ?? { count: 0, total: 0, max: 0 }
  s.count++
  s.total += ms
  if (ms > s.max) {
    s.max = ms
    s.maxDetail = detail
  }
  stats.set(label, s)
  if (ms >= slowMs) {
    // eslint-disable-next-line no-console
    console.warn(
      `[perf] slow ${label}: ${ms.toFixed(1)}ms${detail ? ` (${detail})` : ''}`,
    )
  }
}

// Time a synchronous function under `label`. When profiling is off this is just
// `fn()` with no measurement overhead. `detail` is stashed on the slowest sample
// (e.g. the offending message length) so the report can point at the culprit.
export function timed<T>(label: string, fn: () => T, detail?: string): T {
  if (!enabled) return fn()
  const t0 = performance.now()
  try {
    return fn()
  } finally {
    record(label, performance.now() - t0, detail)
  }
}

// Count an occurrence of `label` (renders, scroll events, timeline builds) with
// no timing — for spotting things that simply happen too often.
export function tick(label: string) {
  if (!enabled) return
  const s = stats.get(label) ?? { count: 0, total: 0, max: 0 }
  s.count++
  stats.set(label, s)
}

function report() {
  const rows = [...stats.entries()]
    .map(([label, s]) => ({
      label,
      count: s.count,
      'total ms': +s.total.toFixed(1),
      'avg ms': +(s.total / s.count).toFixed(2),
      'max ms': +s.max.toFixed(1),
      'slowest sample': s.maxDetail ?? '',
    }))
    .sort((a, b) => b['total ms'] - a['total ms'])
  // eslint-disable-next-line no-console
  console.table(rows)
  return rows
}

// Exposed on window for live console control. Guarded so importing this module
// in a non-browser context (tests, the bench script) doesn't throw.
if (typeof window !== 'undefined') {
  ;(window as unknown as { landerPerf: unknown }).landerPerf = {
    on() {
      enabled = true
      try {
        localStorage.setItem(STORAGE_KEY, '1')
      } catch {
        // storage unavailable — profiling still runs for this session
      }
      // eslint-disable-next-line no-console
      console.info('[perf] on — interact, then landerPerf.report()')
    },
    off() {
      enabled = false
      try {
        localStorage.removeItem(STORAGE_KEY)
      } catch {
        // ignore
      }
      // eslint-disable-next-line no-console
      console.info('[perf] off')
    },
    report,
    reset() {
      stats.clear()
      // eslint-disable-next-line no-console
      console.info('[perf] stats cleared')
    },
    slow(ms: number) {
      slowMs = ms
      // eslint-disable-next-line no-console
      console.info(`[perf] slow-render threshold = ${ms}ms`)
    },
  }
}
