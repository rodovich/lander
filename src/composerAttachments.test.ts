import { describe, expect, it } from 'vitest'
import {
  insertAttachmentMarkers,
  removeAttachmentMarkers,
  shouldAttachPastedText,
} from './composerAttachments'

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

describe('removeAttachmentMarkers', () => {
  it('removes references to cleared files while keeping surrounding prose', () => {
    expect(removeAttachmentMarkers('See [Attachment] and [Attachment 2].\nKeep this.', 2))
      .toBe('See  and .\nKeep this.')
    expect(removeAttachmentMarkers('[Attachment 3] is a quoted label.', 2))
      .toBe('[Attachment 3] is a quoted label.')
  })
})

describe('insertAttachmentMarkers', () => {
  it('replaces a selected passage and keeps the surrounding prose', () => {
    expect(insertAttachmentMarkers('before pasted after', 7, 13, 0, 1)).toEqual({
      text: 'before [Attachment] after',
      caret: 19,
    })
  })

  it('numbers a batch after the files already attached', () => {
    expect(insertAttachmentMarkers('', 0, 0, 1, 2)).toEqual({
      text: '[Attachment 2] [Attachment 3]',
      caret: 29,
    })
  })

  it('separates markers from adjacent prose while preserving line breaks', () => {
    expect(insertAttachmentMarkers('ab', 1, 1, 0, 2).text).toBe(
      'a [Attachment] [Attachment 2] b',
    )
    expect(insertAttachmentMarkers('a\n\nb', 2, 2, 0, 1).text).toBe(
      'a\n[Attachment]\nb',
    )
  })
})
