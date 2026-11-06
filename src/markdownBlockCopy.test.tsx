import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const copied = vi.hoisted(() => [] as { label: string; text: string }[])
vi.mock('./copyButton', () => ({
  CopyButton: ({ text, label }: { text: string; label: string }) => {
    copied.push({ label, text })
    return null
  },
}))

const { Markdown } = await import('./markdown')

// The text each copy button with this label copies, outermost block first.
const copies = (label: string, text: string) => {
  copied.length = 0
  renderToStaticMarkup(<Markdown text={text} />)
  return copied.filter((c) => c.label === label).map((c) => c.text)
}
const quoteCopies = (text: string) => copies('Copy quote', text)
const tableCopies = (text: string) => copies('Copy table', text)

describe('table copy button', () => {
  it('copies the table’s Markdown source', () => {
    const table = '| a | **b** |\n|:--|--:|\n| 1 | `2` |'
    expect(tableCopies(`before\n\n${table}\n\nafter`)).toEqual([table])
  })

  it('strips the prefixes of a quote around the table', () => {
    expect(tableCopies('> | a |\n> |---|\n> | 1 |')).toEqual(['| a |\n|---|\n| 1 |'])
  })
})

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
