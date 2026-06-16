import { Fragment, type ReactNode } from 'react'

// A deliberately small, safe Markdown renderer. It returns React elements
// (never HTML strings / dangerouslySetInnerHTML), so React escapes all text
// for us — raw HTML in the source is rendered as literal text, not markup.
// Supported: headers, ordered/unordered lists, blockquotes, fenced code
// blocks, horizontal rules, and inline bold/italic/code/links.

// Only allow link schemes that can't execute script.
function safeHref(url: string): string | undefined {
  const trimmed = url.trim()
  if (/^(https?:|mailto:)/i.test(trimmed)) return trimmed
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed
  return undefined
}

// Parse inline spans (bold, italic, code, links) into React nodes. Operates on
// plain text, so anything it doesn't recognize stays literal.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let remaining = text
  let key = 0

  // Ordered by precedence: code first so its contents aren't reparsed.
  const patterns: {
    re: RegExp
    render: (m: RegExpMatchArray, k: string) => ReactNode
  }[] = [
    {
      re: /`([^`]+)`/,
      render: (m, k) => <code key={k}>{m[1]}</code>,
    },
    {
      re: /\[([^\]]+)\]\(([^)\s]+)\)/,
      render: (m, k) => {
        const href = safeHref(m[2])
        if (!href) return <Fragment key={k}>{m[0]}</Fragment>
        return (
          <a key={k} href={href} target="_blank" rel="noopener noreferrer">
            {m[1]}
          </a>
        )
      },
    },
    {
      re: /\*\*([^*]+)\*\*|__([^_]+)__/,
      render: (m, k) => <strong key={k}>{m[1] ?? m[2]}</strong>,
    },
    {
      re: /\*([^*]+)\*|_([^_]+)_/,
      render: (m, k) => <em key={k}>{m[1] ?? m[2]}</em>,
    },
  ]

  while (remaining) {
    let best: { index: number; match: RegExpMatchArray; render: (m: RegExpMatchArray, k: string) => ReactNode } | null =
      null
    for (const p of patterns) {
      const m = remaining.match(p.re)
      if (m && m.index !== undefined && (!best || m.index < best.index)) {
        best = { index: m.index, match: m, render: p.render }
      }
    }
    if (!best) {
      nodes.push(remaining)
      break
    }
    if (best.index > 0) nodes.push(remaining.slice(0, best.index))
    nodes.push(best.render(best.match, `${keyPrefix}-i${key++}`))
    remaining = remaining.slice(best.index + best.match[0].length)
  }

  return nodes
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'code'; text: string }
  | { type: 'hr' }
  | { type: 'table'; align: Align[]; header: string[]; rows: string[][] }
  | { type: 'paragraph'; text: string }

type Align = 'left' | 'center' | 'right' | null

// Count leading spaces, used to decide whether a line is nested under a list
// item's marker.
function leadingSpaces(line: string): number {
  return line.match(/^ */)![0].length
}

// Split a "| a | b |" row into trimmed cells, tolerating optional leading and
// trailing pipes. Escaped \| stays literal within a cell.
function splitRow(line: string): string[] {
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
function parseDelimiter(line: string): Align[] | null {
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

// Group raw lines into block-level structures.
function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block. CommonMark allows the opening fence to be indented up
    // to 3 spaces; strip that indent from the body so it aligns at column 0.
    const fence = line.match(/^( {0,3})```/)
    if (fence) {
      const dedent = new RegExp(`^ {0,${fence[1].length}}`)
      const body: string[] = []
      i++
      while (i < lines.length && !/^ {0,3}```/.test(lines[i])) {
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
    const olMatch = line.match(/^\s*\d+[.)]\s+/)
    if (ulMatch || olMatch) {
      const ordered = !!olMatch
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
      blocks.push({ type: 'list', ordered, items })
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
      !/^ {0,3}```|^\s*>|^(#{1,6})\s|^\s*[-*+]\s|^\s*\d+[.)]\s/.test(lines[i]) &&
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
function renderListItem(content: string, key: string): ReactNode {
  const inner = parseBlocks(content)
  if (inner.length === 1 && inner[0].type === 'paragraph') {
    return renderInline(inner[0].text, key)
  }
  return renderBlocks(inner, key)
}

function renderBlocks(blocks: Block[], keyPrefix: string): ReactNode[] {
  return blocks.map((b, idx) => {
    const key = `${keyPrefix}-${idx}`
    switch (b.type) {
          case 'heading': {
            const Tag = `h${b.level}` as keyof JSX.IntrinsicElements
            return <Tag key={key}>{renderInline(b.text, key)}</Tag>
          }
          case 'list':
            return b.ordered ? (
              <ol key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderListItem(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderListItem(it, `${key}-${j}`)}</li>
                ))}
              </ul>
            )
          case 'quote':
            return (
              <blockquote key={key}>{renderInline(b.lines.join('\n'), key)}</blockquote>
            )
          case 'code':
            return (
              <pre key={key}>
                <code>{b.text}</code>
              </pre>
            )
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
                        {renderInline(cell, `${key}-h${j}`)}
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
                          {renderInline(row[c] ?? '', `${key}-${r}-${c}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          case 'paragraph':
            return <p key={key}>{renderInline(b.text, key)}</p>
    }
  })
}

export function Markdown({ text }: { text: string }): JSX.Element {
  return <>{renderBlocks(parseBlocks(text), 'b')}</>
}
