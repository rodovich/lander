import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { safeHref, Markdown } from './markdown'

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

const externalLink = (href: string, label: string) =>
  `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`

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

describe('Markdown rendering', () => {
  it('puts a copy button in the corner of a fenced code block', () => {
    expect(render('```\nnpm test\n```')).toBe(
      '<pre class="code-block"><button type="button" class="code-copy" title="Copy code" aria-label="Copy code">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
        '<rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="2"></rect>' +
        '<path d="M5 15V5a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>' +
        '</svg></button><code>npm test</code></pre>',
    )
  })

  it('renders bold, italic and inline code', () => {
    expect(render('**b**')).toContain('<strong>b</strong>')
    expect(render('*i*')).toContain('<em>i</em>')
    expect(render('`c`')).toContain('<code>c</code>')
  })

  it('renders strikethrough, and nests emphasis inside it', () => {
    expect(render('~~gone~~')).toContain('<del>gone</del>')
    expect(render('~~a **b** c~~')).toContain(
      '<del>a <strong>b</strong> c</del>',
    )
    expect(render('**a ~~b~~ c**')).toContain(
      '<strong>a <del>b</del> c</strong>',
    )
  })

  it('leaves single tildes and home paths alone', () => {
    // A lone "~" must not open a strikethrough, or a message naming two home
    // paths would strike out everything between them.
    const paths = render('~/code/lander and ~/code/easel')
    expect(paths).not.toContain('<del>')
    expect(paths).toContain('~/code/lander and ~/code/easel')
    expect(render('~x~')).not.toContain('<del>')
    // An opening pair with no closer stays literal.
    expect(render('~~a')).not.toContain('<del>')
  })

  it('renders a safe markdown link with security attributes', () => {
    const html = render('[hi](https://example.com)')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('>hi</a>')
  })

  it('renders only the label of a link with an unsafe scheme, never an anchor', () => {
    expect(render('[x](javascript:void)')).toBe('<p>x</p>')
    expect(render('see [agy.ts](file:///a/agy.ts#L1-L2).')).toBe(
      '<p>see agy.ts.</p>',
    )
  })

  it('renders inline formatting in a link label, with or without an anchor', () => {
    const label = '<code>c</code> <strong>b</strong> <em>i</em>'
    expect(render('[`c` **b** _i_](https://x.com)')).toBe(
      `<p>${externalLink('https://x.com', label)}</p>`,
    )
    expect(render('[`c` **b** _i_](file:///x)')).toBe(`<p>${label}</p>`)
  })

  it('autolinks a bare URL and excludes trailing punctuation', () => {
    const html = render('see https://ex.com.')
    expect(html).toContain('href="https://ex.com"')
    expect(html).toContain('>https://ex.com</a>')
    // The sentence-final period stays outside the link.
    expect(html).not.toContain('href="https://ex.com."')
  })

  it('leaves www. domains and email addresses as text', () => {
    expect(render('www.ex.com')).toBe('<p>www.ex.com</p>')
    expect(render('log in as fablab@example.com')).toBe(
      '<p>log in as fablab@example.com</p>',
    )
  })

  it('keeps an email or www. link the author wrote', () => {
    const mail = `<p>${externalLink('mailto:me@x.com', 'me@x.com')}</p>`
    expect(render('[me@x.com](mailto:me@x.com)')).toBe(mail)
    expect(render('<me@x.com>')).toBe(mail)
    expect(render('[www.x.com](https://www.x.com)')).toBe(
      `<p>${externalLink('https://www.x.com', 'www.x.com')}</p>`,
    )
  })

  it('escapes raw HTML instead of emitting markup (XSS defense)', () => {
    const html = render('<script>alert(1)</script>')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('keeps an unquoted placeholder that parses as an HTML tag', () => {
    expect(render('lander artifact put <path> --name <name.png>')).toBe(
      '<p>lander artifact put &lt;path&gt; --name &lt;name.png&gt;</p>',
    )
  })

  it('renders an image as a link to it, never an <img>', () => {
    expect(render('![a cat](https://x.com/cat.png)')).toBe(
      `<p>${externalLink('https://x.com/cat.png', 'a cat')}</p>`,
    )
    expect(render('![a cat](file:///cat.png)')).toBe('<p>a cat</p>')
    // With no alt text, the URL is the label, so the link stays visible.
    expect(render('![](https://x.com/cat.png)')).toBe(
      `<p>${externalLink('https://x.com/cat.png', 'https://x.com/cat.png')}</p>`,
    )
  })

  it('renders block elements inside a blockquote', () => {
    expect(render('> #### What\n>\n> one\n> two\n>\n> ----\n>\n> - a\n> - b')).toBe(
      '<blockquote>\n<h4>What</h4>\n<p>one\ntwo</p>\n<hr/>\n<ul>\n<li>a</li>\n<li>b</li>\n</ul>\n</blockquote>',
    )
  })

  it('ends a blockquote when the next line lacks a matching > marker', () => {
    expect(render('> a quoted line\nfollowed by a reply')).toBe(
      '<blockquote>\n<p>a quoted line</p>\n</blockquote>\n<p>followed by a reply</p>',
    )
    expect(render('> q1\nr1\n> q2\nr2')).toBe(
      '<blockquote>\n<p>q1</p>\n</blockquote>\n<p>r1</p>\n<blockquote>\n<p>q2</p>\n</blockquote>\n<p>r2</p>',
    )
    expect(render('>> a\n> b\nc')).toBe(
      '<blockquote>\n<blockquote>\n<p>a</p>\n</blockquote>\n<p>b</p>\n</blockquote>\n<p>c</p>',
    )
    expect(render('- > quoted\n  reply')).toBe(
      '<ul>\n<li>\n<blockquote>\n<p>quoted</p>\n</blockquote>\nreply</li>\n</ul>',
    )
  })

  it('does not strike out text between single tildes in prompts, amounts or file names', () => {
    for (const s of [
      'ubuntu@web2:~$ free -m\nubuntu@web2:~$ uptime',
      'W is 6–12 runs (~$40–80); E is 6 runs (~$40)',
      'bridge-cafe~wrenched and bridge-cafe~ending',
    ]) {
      expect(render(s)).not.toContain('<del>')
    }
  })

  it('renders a table with per-column alignment styles', () => {
    const html = render('| a | b |\n|:--|--:|\n| 1 | 2 |')
    expect(html).toContain('<table>')
    expect(html).toContain('text-align:left')
    expect(html).toContain('text-align:right')
    expect(html).toContain('>1</td>')
  })

  it('renders a ~280KB pasted log within a loose time bound', () => {
    // A resolver is supplied so the task-mention pass runs too. The bound is
    // deliberately loose (a warm render takes about 200ms) so it flags only a
    // blow-up like a quadratic scan's, which takes seconds. The short render
    // first keeps the parser's first-use cost out of the timing when this test
    // runs alone.
    const line =
      'at resolveBaseSync (file:///Users/x/node_modules/tsx/register.mjs:2:8745)'
    const text = Array.from({ length: 3500 }, () => line).join('\n')
    expect(text.length).toBeGreaterThan(250_000)
    renderToStaticMarkup(<Markdown text={line} linkTask={() => undefined} />)
    const t0 = performance.now()
    renderToStaticMarkup(<Markdown text={text} linkTask={() => undefined} />)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(1500)
  })
})

describe('task-mention linking', () => {
  const FULL = 'abcd1234-5678-90ab-cdef-1234567890ab'
  // A resolver standing in for the app's: links the one known task, by full id
  // or by the 8-char hex prefix that prose from the uuid era abbreviates it to.
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

  it('does not link a task id inside a markdown link label', () => {
    expect(render('[abcd1234](https://x.com)')).toBe(
      `<p>${externalLink('https://x.com', 'abcd1234')}</p>`,
    )
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
    // Every word here is an 8–10 char id-shaped token that the resolver
    // rejects, except the real short id.
    const html = render('resolver modulepath defaults abcd1234 finalize nextStep')
    expect(html).toContain(`href="/proj/${FULL}"`)
    expect(html).toContain('>Fix the parser</a>')
    // The rejected tokens stay literal (no anchors for them).
    expect(html).toContain('<p>resolver modulepath defaults <a ')
    expect(html).toContain('</a> finalize nextStep</p>')
    expect((html.match(/<a /g) ?? []).length).toBe(1)
  })
})

describe('task-mention linking — nanoid ids', () => {
  // Since bee1aab the server mints a 10-char token (mixed case, `_`/`-`) rather
  // than a hex uuid; the detector must linkify those too, plus the 8- and 9-char
  // abbreviations of one left in history by the old "print an unambiguous
  // prefix" guidance.
  const ID = 'gqc9qIVd_F'
  const linkTask = (id: string) => {
    const needle = id.toLowerCase()
    if (ID.toLowerCase().startsWith(needle))
      return { href: `/proj/${ID}`, title: 'Fix the parser', status: 'riding' }
    return undefined
  }
  const render = (text: string) =>
    renderToStaticMarkup(<Markdown text={text} linkTask={linkTask} />)

  it('links a whole 10-char id in a backlink prefix', () => {
    const html = render(`From ${ID}:\n\nhello`)
    expect(html).toContain(`href="/proj/${ID}"`)
    expect(html).toContain('>Fix the parser</a>')
  })

  it('links a 9-char legacy abbreviation of an id', () => {
    const html = render('gqc9qIVd_ pinged')
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

  // No id longer than 10 characters has ever been minted apart from the legacy
  // uuids, which the detector matches as their own whole shape. So a longer run
  // is prose and must never even be offered to the resolver. Asserted with a
  // resolver that links *anything* it is handed, so the length bound in the
  // detector is the only thing that can keep the token literal — with the real
  // resolver above, a too-long token is rejected on lookup and the test would
  // pass no matter what the bound said.
  it('never offers a token longer than any minted id to the resolver', () => {
    const linkAnything = (id: string) => ({
      href: `/proj/${id}`,
      title: 'Fix the parser',
      status: 'riding',
    })
    const html = renderToStaticMarkup(
      <Markdown text="gqc9qIVd_FI8nsAxwHwDk acked" linkTask={linkAnything} />,
    )
    expect(html).not.toContain('<a')
    expect(html).toContain('gqc9qIVd_FI8nsAxwHwDk')
    // Control: the same permissive resolver does link a whole 10-char id, so the
    // assertion above is about the length bound and not a broken fixture.
    const ok = renderToStaticMarkup(
      <Markdown text={`${ID} acked`} linkTask={linkAnything} />,
    )
    expect(ok).toContain(`href="/proj/${ID}"`)
  })

  it('leaves an ordinary same-length word as literal text', () => {
    const html = render('resolver and Background were updated')
    expect(html).not.toContain('<a')
    expect(html).toContain('resolver')
  })
})
