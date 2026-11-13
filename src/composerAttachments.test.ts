import { describe, expect, it } from 'vitest'
import {
  insertAttachmentMarkers,
  removeAttachmentMarkers,
  shouldAttachPastedText,
  uniquelyNamedFiles,
} from './composerAttachments'

const named = (...names: string[]) => names.map((name) => ({ name }))

describe('shouldAttachPastedText', () => {
  it('converts at 1,000 characters or 12 lines', () => {
    expect(shouldAttachPastedText('x'.repeat(999))).toBe(false)
    expect(shouldAttachPastedText('x'.repeat(1000))).toBe(true)
    expect(shouldAttachPastedText(Array(11).fill('x').join('\n'))).toBe(false)
    expect(shouldAttachPastedText(Array(12).fill('x').join('\n'))).toBe(true)
    expect(shouldAttachPastedText('')).toBe(false)
  })

  it('counts Windows and Mac line endings as one line break each', () => {
    for (const separator of ['\r\n', '\r']) {
      expect(shouldAttachPastedText(Array(11).fill('x').join(separator))).toBe(false)
      expect(shouldAttachPastedText(Array(12).fill('x').join(separator))).toBe(true)
    }
  })
})

describe('uniquelyNamedFiles', () => {
  it('numbers names already taken by attached files or earlier files in the batch', () => {
    const picked = [
      new File(['a'], 'image.png', { type: 'image/png' }),
      new File(['b'], 'image.png', { type: 'image/png' }),
      new File(['c'], 'notes', { type: 'text/plain' }),
      new File(['d'], 'other.pdf'),
    ]
    const renamed = uniquelyNamedFiles(named('image.png', 'image-2.png', 'notes'), picked)
    expect(renamed.map((file) => file.name)).toEqual([
      'image-3.png',
      'image-4.png',
      'notes-2',
      'other.pdf',
    ])
    expect(renamed[0].type).toBe('image/png')
  })
})

describe('removeAttachmentMarkers', () => {
  it('removes references to cleared files while keeping surrounding prose', () => {
    expect(removeAttachmentMarkers('See [image.png] and [paste.txt].\nKeep this.', named('image.png', 'paste.txt')))
      .toBe('See  and .\nKeep this.')
    expect(removeAttachmentMarkers('[notes.md] is a quoted label.', named('image.png')))
      .toBe('[notes.md] is a quoted label.')
  })
})

describe('insertAttachmentMarkers', () => {
  it('replaces a selected passage with the file name and keeps the surrounding prose', () => {
    expect(insertAttachmentMarkers('before pasted after', 7, 13, named('paste.txt'))).toEqual({
      text: 'before [paste.txt] after',
      caret: 18,
    })
  })

  it('names each file in a batch', () => {
    expect(insertAttachmentMarkers('', 0, 0, named('a.png', 'b.pdf'))).toEqual({
      text: '[a.png] [b.pdf]',
      caret: 15,
    })
  })

  it('separates markers from adjacent prose while preserving line breaks', () => {
    expect(insertAttachmentMarkers('ab', 1, 1, named('x.png', 'y.png')).text).toBe(
      'a [x.png] [y.png] b',
    )
    expect(insertAttachmentMarkers('a\n\nb', 2, 2, named('x.png')).text).toBe(
      'a\n[x.png]\nb',
    )
  })
})
