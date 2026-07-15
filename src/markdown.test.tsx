import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  safeHref,
  leadingSpaces,
  splitRow,
  parseDelimiter,
  parseBlocks,
  findCodeSpans,
  Markdown,
} from './markdown'

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

// Backtick runs are hard to read inline, so build them by name.
const B = '`'

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

describe('findCodeSpans', () => {
  it('finds single and multi-backtick spans', () => {
    expect(findCodeSpans('a `x` b')).toEqual([
      { start: 2, end: 5, content: 'x' },
    ])
    expect(findCodeSpans(B.repeat(2) + ' ' + B + 'x' + B + ' ' + B.repeat(2))).toEqual(
      [{ start: 0, end: 9, content: '`x`' }],
    )
  })

  it('ignores a run that never closes', () => {
    expect(findCodeSpans(B.repeat(2) + 'a' + B)).toEqual([])
    expect(findCodeSpans('no backticks here')).toEqual([])
  })

  it('never returns adjacent spans, which the NUL mapping relies on', () => {
    // Two spans always have a non-backtick between them: touching spans would
    // mean the first one's closing run wasn't maximal.
    const spans = findCodeSpans('`a` `b` `c`')
    expect(spans).toHaveLength(3)
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThan(spans[i - 1].end)
    }
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
      { type: 'list', ordered: true, start: 1, items: ['a', 'b'] },
    ])
  })

  it('keeps the first marker as the ordered list start', () => {
    expect(parseBlocks('3. a\n4. b')).toEqual([
      { type: 'list', ordered: true, start: 3, items: ['a', 'b'] },
    ])
    // Only the first marker counts — later ones are renumbered from it.
    expect(parseBlocks('2. a\n9. b')).toEqual([
      { type: 'list', ordered: true, start: 2, items: ['a', 'b'] },
    ])
  })

  it('starts each list split by a paragraph at its own marker', () => {
    expect(parseBlocks('1. a\n\npara\n\n2. b')).toEqual([
      { type: 'list', ordered: true, start: 1, items: ['a'] },
      { type: 'paragraph', text: 'para' },
      { type: 'list', ordered: true, start: 2, items: ['b'] },
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

  it('closes a code span on a backtick run of the same length', () => {
    // A longer run is how a backtick gets *inside* code.
    expect(render(B.repeat(2) + ' ' + B + 'x' + B + ' ' + B.repeat(2))).toContain(
      '<code>`x`</code>',
    )
    expect(render(B.repeat(2) + 'a' + B + 'b' + B.repeat(2))).toContain(
      '<code>a`b</code>',
    )
    // A shorter run inside a longer span is just content, not a closer.
    expect(render(B + 'a' + B.repeat(2) + 'b' + B)).toContain(
      '<code>a``b</code>',
    )
  })

  it('leaves an opening run with no equal-length closer literal', () => {
    // Not a span: the run of 2 never closes. It must not be read as a run of 1
    // plus a stray, which would shift every later backtick onto a wrong partner.
    const html = render(B.repeat(2) + 'a' + B)
    expect(html).not.toContain('<code>')
    expect(html).toContain('``a`')
  })

  it('strips one space of padding from a code span', () => {
    expect(render(B + ' x ' + B)).toContain('<code>x</code>')
    // All-spaces content keeps its spaces, else there'd be nothing left.
    expect(render(B + '   ' + B)).toContain('<code>   </code>')
  })

  it('keeps a delimiter inside a code span from opening emphasis', () => {
    // The "*" inside the code span must not close the italic. Regression: it
    // did, and every later backtick then paired with the wrong partner —
    // rendering the prose as code and the commands as prose.
    const html = render(
      '*a rule like `Bash(safe-cmd *)` won\'t run `safe-cmd && other-cmd`*',
    )
    expect(html).toContain(
      '<em>a rule like <code>Bash(safe-cmd *)</code> won&#x27;t run' +
        ' <code>safe-cmd &amp;&amp; other-cmd</code></em>',
    )
    // Same class of bug for the other three delimiters.
    expect(render('**bold `a ** b` end**')).toContain(
      '<strong>bold <code>a ** b</code> end</strong>',
    )
    expect(render('_a `x_y` b_')).toContain('<em>a <code>x_y</code> b</em>')
    expect(render('__a `x__y` b__')).toContain(
      '<strong>a <code>x__y</code> b</strong>',
    )
  })

  it('still emphasizes around a backtick that opens no code span', () => {
    expect(render('*a ` b*')).toContain('<em>a ` b</em>')
  })

  it('renders a NUL in the source as text, not as a code span', () => {
    // Code spans are blanked with NUL before the other patterns scan, so a NUL
    // already in the text must not be mistaken for one.
    const html = render('a\0b')
    expect(html).not.toContain('<code>')
  })

  it('does not blow up on a long backtick run with no closing delimiter', () => {
    const evil = '*' + '`x'.repeat(400) + ' no close'
    const t0 = performance.now()
    render(evil)
    expect(performance.now() - t0).toBeLessThan(500)
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

  it('links the one real id among many non-resolving candidates', () => {
    // Every word here is an 8+ char id-shaped token that the resolver rejects,
    // except the real short id — exercising the scan's skip-past-rejected path.
    const html = render(
      'resolveBaseSync moduleResolve defaultResolve abcd1234 finalizeResolution nextStep',
    )
    expect(html).toContain(`href="/proj/${FULL}"`)
    expect(html).toContain('>Fix the parser</a>')
    // The rejected tokens stay literal (no anchors for them).
    expect(html).toContain('resolveBaseSync')
    expect(html).toContain('finalizeResolution')
    expect((html.match(/<a /g) ?? []).length).toBe(1)
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
