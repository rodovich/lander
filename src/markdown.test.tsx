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
})
