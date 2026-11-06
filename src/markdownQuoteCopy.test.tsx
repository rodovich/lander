import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const copied = vi.hoisted(() => [] as string[])
vi.mock('./copyButton', () => ({
  CopyButton: ({ text, label }: { text: string; label: string }) => {
    if (label === 'Copy quote') copied.push(text)
    return null
  },
}))

const { Markdown } = await import('./markdown')

// The text each quote's copy button copies, outermost quote first.
const quoteCopies = (text: string) => {
  copied.length = 0
  renderToStaticMarkup(<Markdown text={text} />)
  return [...copied]
}

describe('blockquote copy button', () => {
  it('copies the quoted Markdown without its > markers', () => {
    expect(quoteCopies('before\n\n> **bold** and `code`\n>\n> - a\n>- b\n\nafter')).toEqual([
      '**bold** and `code`\n\n- a\n- b',
    ])
  })

  it('keeps a nested quote’s markers in the outer quote’s copy', () => {
    expect(quoteCopies('> outer\n> > inner\n> > more\n> tail')).toEqual([
      'outer\n> inner\n> more\ntail',
      'inner\nmore',
    ])
  })

  it('strips a list item’s indent from a quote inside it', () => {
    expect(quoteCopies('- > one\n  > two')).toEqual(['one\ntwo'])
  })

  it('keeps a fenced code block’s indentation', () => {
    expect(quoteCopies('> ```\n>   indented\n> ```')).toEqual(['```\n  indented\n```'])
  })
})
