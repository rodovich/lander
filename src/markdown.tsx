import { Fragment, memo, useState, type ReactNode } from 'react'
import { timed } from './perf'

// A deliberately small, safe Markdown renderer. It returns React elements
// (never HTML strings / dangerouslySetInnerHTML), so React escapes all text
// for us — raw HTML in the source is rendered as literal text, not markup.
// Supported: headers, ordered/unordered lists, blockquotes, fenced code
// blocks, horizontal rules, and inline bold/italic/code/links.

// Resolves a bare task id (a full UUID) or short id (an 8-char prefix) found in
// message text to an internal link to that task. Returns the link target and
// the task's title (used as the link text), or undefined when nothing matches —
// in which case the id renders as literal text. Purely presentational: it
// doesn't touch the stored message or what's sent to the model.
export type TaskLinkResolver = (
  id: string,
) => { href: string; title: string; status: string } | undefined

// Only allow link schemes that can't execute script.
export function safeHref(url: string): string | undefined {
  const trimmed = url.trim()
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed
  return undefined
}

type CodeSpan = { start: number; end: number; content: string }

// CommonMark strips one space from each end of a code span's content when it is
// padded on both sides. That padding is what lets a span hold a backtick at its
// own edge, as in `` `x` ``.
function stripCodePad(text: string): string {
  const padded = text.length > 1 && text.startsWith(' ') && text.endsWith(' ')
  return padded && /[^ ]/.test(text) ? text.slice(1, -1) : text
}

// Locate every code span. A span opens with a *run* of backticks and closes on
// the next run of the same length, which is how a backtick gets inside code:
// `` `x` `` is one span whose content is `x`. Both runs must be maximal — the
// lookarounds — so ``a` stays literal (its opening run of 2 never closes)
// rather than being read as a shorter run plus a stray.
export function findCodeSpans(text: string): CodeSpan[] {
  if (!text.includes('`')) return []
  const re = /(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g
  const spans: CodeSpan[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) {
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      content: stripCodePad(m[2]),
    })
  }
  return spans
}

// Blank each code span out, preserving length so indices still address `text`.
function maskCodeSpans(text: string, spans: CodeSpan[]): string {
  if (!spans.length) return text
  let out = ''
  let at = 0
  for (const s of spans) {
    out += text.slice(at, s.start) + '\0'.repeat(s.end - s.start)
    at = s.end
  }
  return out + text.slice(at)
}

// Parse inline spans (bold, italic, code, links) into React nodes. Operates on
// plain text, so anything it doesn't recognize stays literal.
function renderInline(
  text: string,
  keyPrefix: string,
  linkTask?: TaskLinkResolver,
): ReactNode[] {
  const nodes: ReactNode[] = []
  let key = 0

  // Code binds tighter than every other inline span, so it is resolved up front
  // rather than competing in the scan below — which picks the earliest match and
  // so can't express "code wins wherever it starts". Each span is blanked out of
  // `masked`, making a delimiter *inside* code inert: the "*" in
  // `Bash(safe-cmd *)` can no longer close an italic opened before it. Emphasis
  // can still span a code span, since the blanks are ordinary body characters.
  const codeSpans = findCodeSpans(text)
  const masked = maskCodeSpans(text, codeSpans)
  const codeAt = new Map(codeSpans.map((s) => [s.start, s.content]))

  // Patterns match against `masked`, so any group whose text gets rendered must
  // be re-sliced from `text` to restore what was blanked. Indices agree because
  // masking preserves length.
  const src = (m: RegExpExecArray) => text.slice(m.index, m.index + m[0].length)
  const group = (m: RegExpExecArray, i: number): string | undefined => {
    const at = m.indices?.[i]
    return at && text.slice(at[0], at[1])
  }

  // Every regex is global so the scan below can resume from a saved lastIndex
  // instead of re-matching the whole tail each step — see the loop's cache
  // comment. The "d" flag is what makes `group` above work.
  //
  // Matches always come from `.exec` below, so `index` is always present —
  // RegExpMatchArray would leave it optional and `src`/`group` need it.
  const patterns: {
    re: RegExp
    render: (m: RegExpExecArray, k: string) => ReactNode
    // Optional gate: a match the predicate rejects is skipped during scanning as
    // if it never matched, so it neither renders nor splits the surrounding
    // literal text into extra nodes. Used by the task-mention pattern so the vast
    // majority of 8+ char tokens (ordinary words that name no task) stay part of
    // one contiguous text node instead of becoming tens of thousands of
    // Fragments — the dominant render/DOM cost on a long pasted log.
    accept?: (m: RegExpExecArray) => boolean
  }[] = [
    {
      // One blanked run is exactly one code span: two spans can never be
      // adjacent, since that would leave the first one's closing run non-maximal.
      // So a run's start index finds its content. `accept` covers the one case
      // that breaks the mapping — a NUL already present in the text — leaving it
      // to render as the ordinary character it is.
      re: /\0+/g,
      accept: (m) => codeAt.has(m.index),
      render: (m, k) => <code key={k}>{codeAt.get(m.index)}</code>,
    },
    {
      re: /\[([^\]]+)\]\(([^)\s]+)\)/gd,
      render: (m, k) => {
        const href = safeHref(group(m, 2) ?? '')
        if (!href) return <Fragment key={k}>{src(m)}</Fragment>
        return (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer">
            {group(m, 1)}
          </a>
        )
      },
    },
    {
      // Underscore variants require a non-word boundary on each side, so
      // intraword underscores (e.g. patch_based_saving) don't become emphasis,
      // matching CommonMark/GFM. That boundary excludes "_" itself, which is
      // what keeps a *run* of underscores whole the way CommonMark's delimiter
      // runs do: in "icon__color and __img" the inner "_" of "icon__" must not
      // count as an opener just because the character before it isn't a letter,
      // or a BEM/dunder identifier pair renders as "icon_<em>color and </em>_img".
      // The bold body is lazy and allows nested "*" so that an inner italic span
      // (e.g. **bold *italic* bold**) is kept inside the bold and reparsed by the
      // recursive renderInline below, rather than splitting the "**" off as
      // literal text.
      re: /\*\*([\s\S]+?)\*\*|(?<![\p{L}\p{N}_])__([^_]+)__(?![\p{L}\p{N}_])/gud,
      render: (m, k) => (
        <strong key={k}>
          {renderInline(group(m, 1) ?? group(m, 2) ?? '', k, linkTask)}
        </strong>
      ),
    },
    {
      re: /\*([^*]+)\*|(?<![\p{L}\p{N}_])_([^_]+)_(?![\p{L}\p{N}_])/gud,
      render: (m, k) => (
        <em key={k}>
          {renderInline(group(m, 1) ?? group(m, 2) ?? '', k, linkTask)}
        </em>
      ),
    },
    {
      // Bare URLs. The greedy body plus a non-punctuation final char keeps
      // trailing punctuation (".", ")", etc.) out of the link. Markdown links
      // win over this since their "[" sits at an earlier index.
      re: /(?:https?:\/\/|www\.)[^\s]*[^\s.,;:!?)\]}'"]/gi,
      render: (m, k) => {
        const raw = src(m)
        const href = safeHref(raw.startsWith('www.') ? `https://${raw}` : raw)
        if (!href) return <Fragment key={k}>{raw}</Fragment>
        return (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer">
            {raw}
          </a>
        )
      },
    },
  ]

  // A bare task reference: a legacy UUID, or a nanoid-style id (or unambiguous
  // prefix of one, as `lander view`/`send`/`archive` accept) drawn from the
  // `[A-Za-z0-9_-]` alphabet the server mints ids from — 8 chars (short enough
  // to be a usable prefix, long enough that an ordinary word rarely collides)
  // up through the 21-char full id, standing alone rather than embedded in a
  // longer alphanumeric/hyphenated run.
  // The UUID form is matched first so a legacy id is taken whole, not clipped to
  // its first 21 chars. Only added when a resolver is supplied; the resolver
  // decides whether the candidate names a real task, so a coincidental token
  // (an ordinary word of the same length) that matches nothing falls back to
  // literal text. The internal link uses a plain anchor (no target) like the
  // lifecycle-event task links, so it navigates within the app.
  if (linkTask) {
    patterns.push({
      re: /(?<![0-9A-Za-z_-])(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-Za-z_-]{8,21})(?![0-9A-Za-z_-])/gi,
      // Only a candidate that resolves to a real task is treated as a match; the
      // rest fall through to literal text without splitting the run (see accept).
      accept: (m) => linkTask(m[0]) !== undefined,
      render: (m, k) => {
        const link = linkTask(m[0])
        if (!link) return <Fragment key={k}>{m[0]}</Fragment>
        return (
          <a
            key={k}
            className={`task-mention ${link.status}`}
            href={link.href}
            title={m[0]}
          >
            {link.title}
          </a>
        )
      },
    })
  }

  // Forward scan with a per-pattern cache. `cursor` is where the next span
  // starts; each pattern's soonest match at/after `cursor` is cached and only
  // re-searched once the cursor passes it. Because a global regex's `.exec`
  // resumes from `lastIndex`, each pattern scans the text at most once overall —
  // making this O(n) rather than the O(n^2) of re-matching the whole tail every
  // step (which froze the UI on a very long message with many matches, e.g. a
  // pasted log where nearly every word trips the task-mention pattern).
  const cache: (RegExpExecArray | null | undefined)[] = patterns.map(
    () => undefined,
  )
  let cursor = 0
  let literalFrom = 0
  while (cursor < text.length) {
    let best: RegExpExecArray | null = null
    let bestPat = -1
    for (let pi = 0; pi < patterns.length; pi++) {
      let m = cache[pi]
      // Refresh a pattern whose cached match is stale (never searched, or now
      // behind the cursor because a chosen span consumed past it).
      if (m === undefined || (m !== null && m.index < cursor)) {
        const { re, accept } = patterns[pi]
        re.lastIndex = cursor
        m = re.exec(masked)
        // Skip matches the pattern rejects (e.g. a token that names no task),
        // advancing past each so the scan resumes after it — the rejected span
        // stays literal rather than becoming its own node.
        while (m && accept && !accept(m)) {
          re.lastIndex = m.index + m[0].length
          m = re.exec(masked)
        }
        cache[pi] = m
      }
      // Earliest wins; ties break by pattern order (precedence), so use `<`.
      if (m && (best === null || m.index < best.index)) {
        best = m
        bestPat = pi
      }
    }
    if (!best) break
    if (best.index > literalFrom) nodes.push(text.slice(literalFrom, best.index))
    nodes.push(patterns[bestPat].render(best, `${keyPrefix}-i${key++}`))
    cursor = best.index + best[0].length
    literalFrom = cursor
  }
  if (literalFrom < text.length) nodes.push(text.slice(literalFrom))

  return nodes
}

// A fenced code block with a clipboard button in its corner, mirroring the
// message-level copy button. Briefly flips to a checkmark after a copy.
function CodeBlock({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied (e.g. insecure context); ignore.
    }
  }
  return (
    <pre className="code-block">
      <button
        type="button"
        className="code-copy"
        onClick={copy}
        title="Copy code"
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M20 6 9 17l-5-5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <rect
              x="9"
              y="9"
              width="11"
              height="11"
              rx="2"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path
              d="M5 15V5a2 2 0 0 1 2-2h10"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        )}
      </button>
      <code>{text}</code>
    </pre>
  )
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; start?: number; items: string[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'code'; text: string }
  | { type: 'hr' }
  | { type: 'table'; align: Align[]; header: string[]; rows: string[][] }
  | { type: 'paragraph'; text: string }

type Align = 'left' | 'center' | 'right' | null

// Count leading spaces, used to decide whether a line is nested under a list
// item's marker.
export function leadingSpaces(line: string): number {
  return line.match(/^ */)![0].length
}

// Split a "| a | b |" row into trimmed cells, tolerating optional leading and
// trailing pipes. Escaped \| stays literal within a cell.
export function splitRow(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  for (let j = 0; j < line.length; j++) {
    const ch = line[j]
    if (ch === '\\' && line[j + 1] === '|') {
      cur += '|'
      j++
    } else if (ch === '|') {
      cells.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur)
  // Drop the empty cells produced by leading/trailing pipes.
  if (cells.length && cells[0].trim() === '') cells.shift()
  if (cells.length && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((c) => c.trim())
}

// A delimiter row looks like |---|:--:|---:| — dashes with optional colons.
export function parseDelimiter(line: string): Align[] | null {
  if (!line.includes('|') && !/^[\s:-]+$/.test(line)) return null
  const cells = splitRow(line)
  if (cells.length === 0) return null
  const align: Align[] = []
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null
    const left = c.startsWith(':')
    const right = c.endsWith(':')
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null)
  }
  return align
}

// Opens a fenced code block: three or more backticks, then an info string that
// may not itself contain a backtick. That last rule is what tells a fence from
// an inline code span that happens to start a line, as in ```a``b```.
//
// The block scan and its paragraph guard below must both use this: a line the
// scan won't open a fence for, but the guard still treats as a block start,
// belongs to no branch at all and stalls the scan on that line.
const FENCE_OPEN = /^( {0,3})(`{3,})[^`]*$/

// Group raw lines into block-level structures.
export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block. CommonMark allows the opening fence to be indented up
    // to 3 spaces; strip that indent from the body so it aligns at column 0.
    const fence = line.match(FENCE_OPEN)
    if (fence) {
      const dedent = new RegExp(`^ {0,${fence[1].length}}`)
      // The closer is a run at least as long as the opener followed by nothing
      // but spaces, so a shorter run — or one trailing an info string — is body
      // text. That's what lets a block quoting ``` sit inside a ```` fence.
      const close = new RegExp(`^ {0,3}\`{${fence[2].length},}\\s*$`)
      const body: string[] = []
      i++
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i].replace(dedent, ''))
        i++
      }
      if (i < lines.length) i++ // closing fence
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }

    if (line.trim() === '') {
      i++
      continue
    }

    const hr = line.match(/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/)
    if (hr) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      i++
      continue
    }

    if (/^\s*>/.test(line)) {
      const quote: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      blocks.push({ type: 'quote', lines: quote })
      continue
    }

    const ulMatch = line.match(/^\s*[-*+]\s+/)
    const olMatch = line.match(/^\s*(\d+)[.)]\s+/)
    if (ulMatch || olMatch) {
      const ordered = !!olMatch
      // Per CommonMark only the first marker's number counts; the rest are
      // renumbered from it, so the browser's own counter takes over from here.
      const start = olMatch ? Number(olMatch[1]) : undefined
      const markerRe = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/
      const items: string[] = []
      while (i < lines.length) {
        // Allow blank lines to separate items (a "loose" list).
        let start = i
        while (start < lines.length && lines[start].trim() === '') start++
        const marker = start < lines.length ? lines[start].match(markerRe) : null
        if (!marker) break
        i = start
        // The marker width is the indent that the item's continuation lines
        // (wrapped text, code blocks, sub-lists) align to.
        const contentIndent = marker[0].length
        const itemLines = [lines[i].slice(contentIndent)]
        i++
        while (i < lines.length) {
          const l = lines[i]
          if (l.trim() === '') {
            // Keep the blank only if indented content follows it.
            let k = i + 1
            while (k < lines.length && lines[k].trim() === '') k++
            if (k < lines.length && leadingSpaces(lines[k]) >= contentIndent) {
              itemLines.push('')
              i++
              continue
            }
            break
          }
          // Anything less-indented (a sibling marker, or the next block) ends
          // this item; more-indented lines are its nested content.
          if (leadingSpaces(l) < contentIndent) break
          itemLines.push(l.slice(contentIndent))
          i++
        }
        items.push(itemLines.join('\n').replace(/\n+$/, ''))
      }
      blocks.push({ type: 'list', ordered, start, items })
      continue
    }

    // Table: a header row followed by a delimiter row, then zero+ body rows.
    if (line.includes('|') && i + 1 < lines.length) {
      const align = parseDelimiter(lines[i + 1])
      if (align) {
        const header = splitRow(line)
        i += 2
        const rows: string[][] = []
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
          rows.push(splitRow(lines[i]))
          i++
        }
        blocks.push({ type: 'table', align, header, rows })
        continue
      }
    }

    // Paragraph: gather consecutive non-blank, non-special lines. Stops before
    // a table so an adjacent table isn't swallowed.
    const para: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !FENCE_OPEN.test(lines[i]) &&
      !/^\s*>|^(#{1,6})\s|^\s*[-*+]\s|^\s*\d+[.)]\s/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && parseDelimiter(lines[i + 1]))
    ) {
      para.push(lines[i])
      i++
    }
    blocks.push({ type: 'paragraph', text: para.join('\n') })
  }

  return blocks
}

// Render a list item's content. A lone paragraph renders inline (a tight item,
// the common case); richer content — e.g. a paragraph followed by a code block —
// renders as nested block elements.
function renderListItem(
  content: string,
  key: string,
  linkTask?: TaskLinkResolver,
): ReactNode {
  const inner = parseBlocks(content)
  if (inner.length === 1 && inner[0].type === 'paragraph') {
    return renderInline(inner[0].text, key, linkTask)
  }
  return renderBlocks(inner, key, linkTask)
}

function renderBlocks(
  blocks: Block[],
  keyPrefix: string,
  linkTask?: TaskLinkResolver,
): ReactNode[] {
  return blocks.map((b, idx) => {
    const key = `${keyPrefix}-${idx}`
    switch (b.type) {
          case 'heading': {
            const Tag = `h${b.level}` as keyof JSX.IntrinsicElements
            return <Tag key={key}>{renderInline(b.text, key, linkTask)}</Tag>
          }
          case 'list':
            return b.ordered ? (
              <ol key={key} start={b.start !== 1 ? b.start : undefined}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderListItem(it, `${key}-${j}`, linkTask)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderListItem(it, `${key}-${j}`, linkTask)}</li>
                ))}
              </ul>
            )
          case 'quote':
            return (
              <blockquote key={key}>
                {renderInline(b.lines.join('\n'), key, linkTask)}
              </blockquote>
            )
          case 'code':
            return <CodeBlock key={key} text={b.text} />
          case 'hr':
            return <hr key={key} />
          case 'table':
            return (
              <table key={key}>
                <thead>
                  <tr>
                    {b.header.map((cell, j) => (
                      <th
                        key={j}
                        style={b.align[j] ? { textAlign: b.align[j]! } : undefined}
                      >
                        {renderInline(cell, `${key}-h${j}`, linkTask)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, r) => (
                    <tr key={r}>
                      {b.header.map((_, c) => (
                        <td
                          key={c}
                          style={b.align[c] ? { textAlign: b.align[c]! } : undefined}
                        >
                          {renderInline(row[c] ?? '', `${key}-${r}-${c}`, linkTask)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          case 'paragraph':
            return <p key={key}>{renderInline(b.text, key, linkTask)}</p>
    }
  })
}

// Memoized so an unchanged (text, linkTask) pair reuses the prior render instead
// of re-parsing and re-building the element tree. This is what makes the long
// user message stop re-rendering on unrelated App updates (poll/scroll/focus);
// it relies on callers passing a referentially stable linkTask (see App's
// resolveTaskLink). Still profiled (opt-in; see perf.ts) so a genuine re-render —
// or a caller that busts the memo — shows up in `landerPerf.report()`, timing
// the block split and the inline-span pass separately.
export const Markdown = memo(function Markdown({
  text,
  linkTask,
}: {
  text: string
  linkTask?: TaskLinkResolver
}): JSX.Element {
  const detail = `${text.length}c${linkTask ? ' +linkTask' : ''}`
  const blocks = timed('markdown.parse', () => parseBlocks(text), detail)
  return timed(
    'markdown.render',
    () => <>{renderBlocks(blocks, 'b', linkTask)}</>,
    detail,
  )
})
