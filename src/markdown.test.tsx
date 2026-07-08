import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  safeHref,
  leadingSpaces,
  splitRow,
  parseDelimiter,
  parseBlocks,
  Markdown,
} from './markdown'

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

describe('safeHref', () => {
  it('allows http(s) and mailto, case-insensitively', () => {
    expect(safeHref('https://x.com')).toBe('https://x.com')
    expect(safeHref('http://x.com')).toBe('http://x.com')
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com')
    expect(safeHref('HtTpS://x.com')).toBe('HtTpS://x.com')
  })

  it('allows root-relative and fragment links', () => {
    expect(safeHref('/path')).toBe('/path')
    expect(safeHref('#anchor')).toBe('#anchor')
  })

  it('rejects javascript:, data:, vbscript:, file: and unknown schemes', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined()
    expect(safeHref('data:text/html,<script>')).toBeUndefined()
    expect(safeHref('vbscript:msgbox')).toBeUndefined()
    expect(safeHref('file:///etc/passwd')).toBeUndefined()
    expect(safeHref('tel:+1')).toBeUndefined()
  })

  it('trims surrounding whitespace before testing', () => {
    expect(safeHref('  https://x.com  ')).toBe('https://x.com')
    expect(safeHref('  javascript:alert(1)')).toBeUndefined()
  })

  it('does not let embedded whitespace smuggle a scheme past the allowlist', () => {
    expect(safeHref('java\tscript:alert(1)')).toBeUndefined()
    expect(safeHref(' Java Script:alert(1)')).toBeUndefined()
  })

  it('treats a scheme-relative // URL as root-relative (documented behavior)', () => {
    expect(safeHref('//evil.com')).toBe('//evil.com')
  })
})

describe('leadingSpaces', () => {
  it('counts only leading spaces (tabs do not count)', () => {
    expect(leadingSpaces('   x')).toBe(3)
    expect(leadingSpaces('x')).toBe(0)
    expect(leadingSpaces('')).toBe(0)
    expect(leadingSpaces('    ')).toBe(4)
    expect(leadingSpaces('\tx')).toBe(0)
  })
})

describe('splitRow', () => {
  it('splits and trims cells, tolerating optional outer pipes', () => {
    expect(splitRow('| a | b |')).toEqual(['a', 'b'])
    expect(splitRow('a | b')).toEqual(['a', 'b'])
    expect(splitRow('abc')).toEqual(['abc'])
  })

  it('keeps an escaped \\| literal within a cell', () => {
    expect(splitRow('a \\| b | c')).toEqual(['a | b', 'c'])
  })

  it('preserves interior empty cells but drops blank outer ones', () => {
    expect(splitRow('a || b')).toEqual(['a', '', 'b'])
    expect(splitRow('| a |  | b |')).toEqual(['a', '', 'b'])
  })

  it('does not run off the end on a trailing backslash', () => {
    expect(splitRow('a\\')).toEqual(['a\\'])
  })
})

describe('parseDelimiter', () => {
  it('reads per-column alignment', () => {
    expect(parseDelimiter('|---|:--:|---:|')).toEqual([null, 'center', 'right'])
    expect(parseDelimiter('|:---|')).toEqual(['left'])
  })

  it('returns null for a non-delimiter row', () => {
    expect(parseDelimiter('a | b')).toBeNull()
    expect(parseDelimiter('|--x--|')).toBeNull()
  })

  it('parses a pipe-less run of dashes as a single column (documented)', () => {
    expect(parseDelimiter('---')).toEqual([null])
  })
})

describe('parseBlocks', () => {
  it('parses a fenced code block, dedenting by the fence indent', () => {
    expect(parseBlocks('  ```\n  code\n  ```')).toEqual([{ type: 'code', text: 'code' }])
  })

  it('consumes an unclosed fence to EOF without crashing', () => {
    expect(parseBlocks('```\nx')).toEqual([{ type: 'code', text: 'x' }])
  })

  it('parses headings 1-6, but 7 hashes is a paragraph', () => {
    expect(parseBlocks('# H')).toEqual([{ type: 'heading', level: 1, text: 'H' }])
    expect(parseBlocks('###### H')).toEqual([{ type: 'heading', level: 6, text: 'H' }])
    expect(parseBlocks('####### H')[0].type).toBe('paragraph')
  })

  it('parses horizontal rules', () => {
    expect(parseBlocks('---')).toEqual([{ type: 'hr' }])
    expect(parseBlocks('***')).toEqual([{ type: 'hr' }])
  })

  it('parses a blockquote, stripping one > per line', () => {
    expect(parseBlocks('> a\n> b')).toEqual([{ type: 'quote', lines: ['a', 'b'] }])
  })

  it('parses ordered and unordered lists', () => {
    expect(parseBlocks('- a\n- b')).toEqual([
      { type: 'list', ordered: false, items: ['a', 'b'] },
    ])
    expect(parseBlocks('1. a\n2. b')).toEqual([
      { type: 'list', ordered: true, items: ['a', 'b'] },
    ])
  })

  it('tolerates a blank line between items (loose list)', () => {
    expect(parseBlocks('- a\n\n- b')).toEqual([
      { type: 'list', ordered: false, items: ['a', 'b'] },
    ])
  })

  it('folds an indented continuation line into the item', () => {
    expect(parseBlocks('- a\n  cont')).toEqual([
      { type: 'list', ordered: false, items: ['a\ncont'] },
    ])
  })

  it('parses a table (header + delimiter + rows)', () => {
    expect(parseBlocks('| a | b |\n|:--|--:|\n| 1 | 2 |')).toEqual([
      {
        type: 'table',
        align: ['left', 'right'],
        header: ['a', 'b'],
        rows: [['1', '2']],
      },
    ])
  })

  it('stops a paragraph before an adjacent table', () => {
    const blocks = parseBlocks('para\n| a | b |\n|---|---|')
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'table'])
    expect(blocks[0]).toEqual({ type: 'paragraph', text: 'para' })
  })

  it('normalizes CRLF and CR before parsing', () => {
    expect(parseBlocks('# H\r\nx\ry')).toEqual([
      { type: 'heading', level: 1, text: 'H' },
      { type: 'paragraph', text: 'x\ny' },
    ])
  })

  it('returns [] for empty input', () => {
    expect(parseBlocks('')).toEqual([])
  })
})

describe('Markdown rendering', () => {
  it('renders bold, italic and inline code', () => {
    expect(render('**b**')).toContain('<strong>b</strong>')
    expect(render('*i*')).toContain('<em>i</em>')
    expect(render('`c`')).toContain('<code>c</code>')
  })

  it('nests emphasis inside bold', () => {
    expect(render('**b _i_**')).toContain('<strong>b <em>i</em></strong>')
    // Asterisk italic nested in bold: the "*" inside must stay within the bold
    // rather than splitting the "**" off as literal text.
    expect(render('**a *b* c**')).toContain('<strong>a <em>b</em> c</strong>')
    expect(render('**a *b* c**')).not.toContain('**')
  })

  it('does not emphasize intraword underscores, but does intraword asterisks', () => {
    const u = render('patch_based_saving')
    expect(u).toContain('patch_based_saving')
    expect(u).not.toContain('<em>')
    expect(render('foo*bar*baz')).toContain('<em>bar</em>')
  })

  it('renders a safe markdown link with security attributes', () => {
    const html = render('[hi](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('>hi</a>')
  })

  it('renders a javascript: link as literal text, never an anchor', () => {
    const html = render('[x](javascript:alert(1))')
    expect(html).not.toContain('<a')
    expect(html).toContain('javascript:alert(1)')
  })

  it('autolinks a bare URL and excludes trailing punctuation', () => {
    const html = render('see https://ex.com.')
    expect(html).toContain('href="https://ex.com"')
    expect(html).toContain('>https://ex.com</a>')
    // The sentence-final period stays outside the link.
    expect(html).not.toContain('href="https://ex.com."')
  })

  it('autolinks www. with an https href but keeps the www. display text', () => {
    const html = render('www.ex.com')
    expect(html).toContain('href="https://www.ex.com"')
    expect(html).toContain('>www.ex.com</a>')
  })

  it('escapes raw HTML instead of emitting markup (XSS defense)', () => {
    const html = render('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders a table with per-column alignment styles', () => {
    const html = render('| a | b |\n|:--|--:|\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('text-align:left')
    expect(html).toContain('text-align:right')
    expect(html).toContain('>1</td>')
  })

  it('renders an empty string to empty output', () => {
    expect(render('')).toBe('')
  })

  it('renders many adjacent inline spans in order (forward-scan cache)', () => {
    const html = render('`a` **b** *c* `d` [e](https://x.com) tail')
    expect(html).toBe(
      '<p><code>a</code> <strong>b</strong> <em>c</em> <code>d</code> ' +
        '<a href="https://x.com" target="_blank" rel="noopener noreferrer">e</a>' +
        ' tail</p>',
    )
  })

  it('keeps literal runs between and around matches intact', () => {
    expect(render('before `x` middle `y` after')).toContain(
      'before <code>x</code> middle <code>y</code> after',
    )
    // A lone match at the very start, with a trailing literal, and vice versa.
    expect(render('`x` tail')).toContain('<p><code>x</code> tail</p>')
    expect(render('head `x`')).toContain('<p>head <code>x</code></p>')
  })

  it('handles a long run of matches without altering output (perf-path)', () => {
    // Exercises the per-pattern cache over many matches — the scenario that was
    // O(n^2). Output must be identical to the naive per-token expansion.
    const html = render(Array.from({ length: 50 }, () => '`c`').join(' '))
    expect(html).toBe(
      '<p>' + Array.from({ length: 50 }, () => '<code>c</code>').join(' ') + '</p>',
    )
  })

  it('renders a ~280KB message quickly (O(n) inline scan regression guard)', () => {
    // A pasted log dump: many 8+ char tokens, each of which trips the
    // task-mention pattern. Under the old O(n^2) tail-rescan this took seconds
    // (~800ms of scheduler work per re-render in the UI); the forward scan makes
    // it linear. A resolver is supplied so the task-mention pattern is active —
    // the worst case. The bound is deliberately loose (linear render is single-
    // digit ms here) so it flags only a genuine complexity regression.
    const line =
      'at resolveBaseSync (file:///Users/x/node_modules/tsx/register.mjs:2:8745)'
    const text = Array.from({ length: 3500 }, () => line).join('\n')
    expect(text.length).toBeGreaterThan(250_000)
    const t0 = performance.now()
    renderToStaticMarkup(<Markdown text={text} linkTask={() => undefined} />)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(1500)
  })
})

describe('task-mention linking', () => {
  const FULL = 'abcd1234-5678-90ab-cdef-1234567890ab'
  // A resolver standing in for the app's: links the one known task, by full id
  // or by an 8-char prefix.
  const linkTask = (id: string) => {
    const needle = id.toLowerCase()
    if (FULL === needle || (needle.length === 8 && FULL.startsWith(needle)))
      return { href: `/proj/${FULL}`, title: 'Fix the parser', status: 'riding' }
    return undefined
  }
  const render = (text: string) =>
    renderToStaticMarkup(<Markdown text={text} linkTask={linkTask} />)

  it('links a full task id, using the title as the link text', () => {
    const html = render(`status of ${FULL}?`)
    expect(html).toContain(`href="/proj/${FULL}"`)
    expect(html).toContain('Fix the parser')
    expect(html).toContain('task-mention')
    // The raw id is not shown as the visible text (only as the title attr).
    expect(html).toContain('>Fix the parser</a>')
  })

  it('links a standalone 8-char short id', () => {
    const html = render('abcd1234 is wedged')
    expect(html).toContain(`href="/proj/${FULL}"`)
    expect(html).toContain('>Fix the parser</a>')
  })

  it('leaves an id that matches no task as literal text', () => {
    const html = render('deadbeef is unknown')
    expect(html).not.toContain('<a')
    expect(html).toContain('deadbeef')
  })

  it('does not link a hex run longer than a short id', () => {
    const html = render('abcd1234ef is not a short id')
    expect(html).not.toContain('<a')
    expect(html).toContain('abcd1234ef')
  })

  it('does not link ids when no resolver is supplied', () => {
    const html = renderToStaticMarkup(<Markdown text={`see ${FULL}`} />)
    expect(html).not.toContain('<a')
    expect(html).toContain(FULL)
  })

  it('links an id inside emphasis', () => {
    const html = render('*abcd1234*')
    expect(html).toContain('<em>')
    expect(html).toContain(`href="/proj/${FULL}"`)
  })
})

describe('task-mention linking — nanoid ids', () => {
  // The server now mints nanoid-style ids (mixed case, `_`/`-`, lengths 10 and
  // 21) rather than hex uuids; the detector must linkify those too.
  const ID = 'gqc9qIVdF-I8nsAxwHwDk'
  const linkTask = (id: string) => {
    const needle = id.toLowerCase()
    if (ID.toLowerCase().startsWith(needle))
      return { href: `/proj/${ID}`, title: 'Fix the parser', status: 'riding' }
    return undefined
  }
  const render = (text: string) =>
    renderToStaticMarkup(<Markdown text={text} linkTask={linkTask} />)

  it('links a full 21-char nanoid id in a backlink prefix', () => {
    const html = render(`From ${ID}:\n\nhello`)
    expect(html).toContain(`href="/proj/${ID}"`)
    expect(html).toContain('>Fix the parser</a>')
  })

  it('links a 10-char prefix of a nanoid id', () => {
    // `gqc9qIVdF-` is the first 10 chars of the known id and resolves uniquely.
    const html = render('gqc9qIVdF- pinged')
    expect(html).toContain(`href="/proj/${ID}"`)
  })

  it('leaves an unrelated 10-char token as literal text', () => {
    const html = render('Bra9gs7BFe acked')
    expect(html).not.toContain('<a')
    expect(html).toContain('Bra9gs7BFe')
  })

  it('links a standalone 8-char short id', () => {
    const html = render('gqc9qIVd is riding')
    expect(html).toContain(`href="/proj/${ID}"`)
  })

  it('leaves an ordinary same-length word as literal text', () => {
    const html = render('resolver and Background were updated')
    expect(html).not.toContain('<a')
    expect(html).toContain('resolver')
  })
})
