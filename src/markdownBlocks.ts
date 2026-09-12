// The block layer of the Markdown renderer: raw text grouped into headings,
// lists, quotes, fenced code, rules, tables, and paragraphs. Pure — it knows
// nothing of React or of what the inline text inside each block says, which the
// renderer (markdown.tsx) reads span by span as it draws.

export type Align = 'left' | 'center' | 'right' | null

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; start?: number; items: string[] }
  | { type: 'quote'; lines: string[] }
  | { type: 'code'; text: string }
  | { type: 'hr' }
  | { type: 'table'; align: Align[]; header: string[]; rows: string[][] }
  | { type: 'paragraph'; text: string }

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
