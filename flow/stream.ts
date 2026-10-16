import type { Usage } from '../shared/stream'

// Reduce a tool call's input to a one-line summary for the activity chip. Picks
// the most identifying string field, collapses whitespace, and caps the length.
export function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const v =
    str('file_path') ||
    str('path') ||
    str('command') ||
    str('pattern') ||
    str('query') ||
    str('url') ||
    str('description')
  // The Agent tool carries the agent flavor in `subagent_type`; lead its summary
  // with it (e.g. `Explore: <description>`) so an Explore call reads differently
  // from a general Agent at a glance — both share the bare tool name `Agent`.
  const sub = str('subagent_type')
  const summary = sub ? (v ? `${sub}: ${v}` : sub) : v || JSON.stringify(i)
  const flat = summary.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? flat.slice(0, 200) + '…' : flat
}

// The one-line `input` summary's untruncated, newline-preserving twin: the same
// identifying field, but with whitespace (and line breaks) left intact and only a
// 4k cap, so the expanded chip can render a multi-line command or a long argument
// as written. Field-selection order matches summarizeToolInput; the cap mirrors
// diffEdits. Callers store it only when it differs from the one-line summary (see
// reduceStreamLine) — a short single-line input needs no second copy.
export function fullToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const v =
    str('file_path') ||
    str('path') ||
    str('command') ||
    str('pattern') ||
    str('query') ||
    str('url') ||
    str('description')
  const sub = str('subagent_type')
  const full = sub ? (v ? `${sub}: ${v}` : sub) : v || JSON.stringify(i)
  return full.length > 4000 ? full.slice(0, 4000) + '\n…' : full
}

// Render a tool call as a settings.json-style permission rule, e.g.
// `Bash(npm run build)`. Keys off the same identifying field as
// summarizeToolInput but leaves it untruncated, so the popup can show — and let
// the user grant — the exact invocation. A tool with no obvious specifier becomes
// a bare tool name.
//
// A path is copied as the call gave it, so an absolute one comes out
// `Read(/path/to/file)` — which Claude reads as relative to the rule's source,
// not the filesystem root. The Claude flow re-spells it before it reaches the
// timeline (anchorFileRule in daemon/flows/claude.ts).
//
// Claude matches web tools by their own grammar, not the call's input: WebFetch
// only by `domain:<host>` (a `WebFetch(<url>)` rule matches nothing), and
// WebSearch only bare (a `WebSearch(<query>)` rule matches nothing). Checked
// against CLI 2.1.280.
export function toolRule(name: string, input: unknown): string {
  if (name === 'WebSearch') return name
  if (!input || typeof input !== 'object') return name
  const i = input as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  if (name === 'WebFetch') {
    const host = URL.parse(str('url'))?.hostname
    return host ? `${name}(domain:${host})` : name
  }
  const spec =
    str('command') ||
    str('file_path') ||
    str('path') ||
    str('pattern') ||
    str('query') ||
    str('url')
  return spec ? `${name}(${spec})` : name
}

// Pull the before/after hunks out of a file-writing tool's input so the UI can
// show its diff: Edit is one hunk (old_string → new_string), MultiEdit is one
// per entry, and Write is a single hunk against an empty original. Returns
// undefined for any other tool. Each side is capped so a giant edit can't bloat
// the task file; the UI only needs a readable peek.
export function diffEdits(
  name: string,
  input: unknown,
): { old: string; new: string }[] | undefined {
  if (!input || typeof input !== 'object') return undefined
  const i = input as Record<string, unknown>
  const cap = (v: unknown) => {
    const s = typeof v === 'string' ? v : ''
    return s.length > 4000 ? s.slice(0, 4000) + '\n…' : s
  }
  if (name === 'Edit') {
    if (typeof i.old_string === 'string' && typeof i.new_string === 'string')
      return [{ old: cap(i.old_string), new: cap(i.new_string) }]
  } else if (name === 'Write') {
    if (typeof i.content === 'string') return [{ old: '', new: cap(i.content) }]
  } else if (name === 'MultiEdit') {
    if (Array.isArray(i.edits))
      return i.edits
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({
          old: cap((e as Record<string, unknown>).old_string),
          new: cap((e as Record<string, unknown>).new_string),
        }))
  }
  return undefined
}

// Concatenate a tool_result block's content (a plain string or an array of
// content blocks) into its raw text, preserving newlines.
export function rawToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((b) => (b && typeof b === 'object' ? String((b as any).text ?? '') : ''))
      .join('')
  return ''
}

// A short text peek at a tool_result for the activity trace. Keeps line breaks
// so multi-line output stays readable, but caps the peek at 200 characters or 3
// lines, whichever comes first. A character cap appends an inline ellipsis; a
// line cap puts the ellipsis on its own line.
export function summarizeToolResult(content: unknown): string {
  let text = rawToolResultText(content).trim()
  let charCapped = false
  if (text.length > 200) {
    text = text.slice(0, 200)
    charCapped = true
  }
  const lines = text.split('\n')
  if (lines.length > 3) return lines.slice(0, 3).join('\n') + '\n…'
  return charCapped ? text + '…' : text
}

// Add one inference's usage onto the turn's running total. Token counts sum; the
// model is the latest inference's (turns are effectively single-model, and the
// caller stamps the session's driving model over it regardless). Cost
// sums too, staying undefined until a snapshot carries one (only the result event
// does), so a still-streaming turn reports no cost rather than a misleading zero.
export function addUsage(acc: Usage | undefined, next: Usage): Usage {
  if (!acc) return next
  return {
    input: acc.input + next.input,
    output: acc.output + next.output,
    cacheRead: acc.cacheRead + next.cacheRead,
    cacheCreation: acc.cacheCreation + next.cacheCreation,
    model: next.model ?? acc.model,
    costUsd:
      acc.costUsd === undefined && next.costUsd === undefined
        ? undefined
        : (acc.costUsd ?? 0) + (next.costUsd ?? 0),
    // The first reported miss wins: it's the turn-start (resume-boundary) miss,
    // which is the one that tells the caching story for the turn.
    ...(acc.cacheMiss ?? next.cacheMiss
      ? { cacheMiss: acc.cacheMiss ?? next.cacheMiss }
      : {}),
  }
}
