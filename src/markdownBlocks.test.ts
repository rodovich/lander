import { describe, it, expect } from 'vitest'
import {
  leadingSpaces,
  splitRow,
  parseDelimiter,
  parseBlocks,
} from './markdownBlocks'

// Backtick runs are hard to read inline, so build them by name.
const B = '`'

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

  it('does not open a fence when the info string holds a backtick', () => {
    // ```a``b``` is an inline code span that happens to start a line, not a
    // fence. Both the fence scan and the paragraph guard have to agree on that:
    // if only one does, the line starts no block and is consumed by none, and
    // parseBlocks spins on it. A failure here may show up as a timeout.
    const src = B.repeat(3) + 'a' + B.repeat(2) + 'b' + B.repeat(3)
    expect(parseBlocks(src)).toEqual([{ type: 'paragraph', text: src }])
    expect(parseBlocks(B.repeat(3) + 'js' + B)).toEqual([
      { type: 'paragraph', text: B.repeat(3) + 'js' + B },
    ])
  })

  it('closes a fence only on a run at least as long as the opener', () => {
    // So a block quoting ``` can sit inside a ```` fence.
    expect(
      parseBlocks(
        B.repeat(4) + '\n' + B.repeat(3) + '\ninner\n' + B.repeat(3) + '\n' + B.repeat(4),
      ),
    ).toEqual([
      { type: 'code', text: B.repeat(3) + '\ninner\n' + B.repeat(3) },
    ])
    // Trailing spaces after the closer are still fine.
    expect(parseBlocks('```\ncode\n```   ')).toEqual([
      { type: 'code', text: 'code' },
    ])
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
