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
  | { type: 'paragraph'; text: string }

// Group raw lines into block-level structures.
function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block.
    const fence = line.match(/^```/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
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

    const ulMatch = line.match(/^\s*[-*+]\s+(.*)$/)
    const olMatch = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ulMatch || olMatch) {
      const ordered = !!olMatch
      const items: string[] = []
      while (i < lines.length) {
        const m = ordered
          ? lines[i].match(/^\s*\d+[.)]\s+(.*)$/)
          : lines[i].match(/^\s*[-*+]\s+(.*)$/)
        if (!m) break
        items.push(m[1])
        i++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }

    // Paragraph: gather consecutive non-blank, non-special lines.
    const para: string[] = []
    while (i < lines.length && lines[i].trim() !== '' && !/^```|^\s*>|^(#{1,6})\s|^\s*[-*+]\s|^\s*\d+[.)]\s/.test(lines[i])) {
      para.push(lines[i])
      i++
    }
    blocks.push({ type: 'paragraph', text: para.join('\n') })
  }

  return blocks
}

export function Markdown({ text }: { text: string }): JSX.Element {
  const blocks = parseBlocks(text)
  return (
    <>
      {blocks.map((b, idx) => {
        const key = `b${idx}`
        switch (b.type) {
          case 'heading': {
            const Tag = `h${b.level}` as keyof JSX.IntrinsicElements
            return <Tag key={key}>{renderInline(b.text, key)}</Tag>
          }
          case 'list':
            return b.ordered ? (
              <ol key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </ol>
            ) : (
              <ul key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}-${j}`)}</li>
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
          case 'paragraph':
            return <p key={key}>{renderInline(b.text, key)}</p>
        }
      })}
    </>
  )
}
