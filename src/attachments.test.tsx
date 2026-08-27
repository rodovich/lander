import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  adjacentFileIndex,
  MessageAttachments,
  previewKind,
} from './attachments'
import type { Attachment } from './types'

const file = (mime: string, name = 'file'): Attachment => ({
  id: 'attachment-1',
  name,
  mime,
  size: 42,
})

describe('attachment previews', () => {
  it('classifies browser-previewable file types', () => {
    expect(previewKind(file('image/png'))).toBe('image')
    expect(previewKind(file('text/csv; charset=utf-8'))).toBe('text')
    expect(previewKind(file('application/problem+json'))).toBe('text')
    expect(previewKind(file('application/octet-stream', 'component.tsx'))).toBe('text')
    expect(previewKind(file('application/pdf'))).toBe('pdf')
    expect(previewKind(file('audio/mpeg'))).toBe('audio')
    expect(previewKind(file('video/mp4'))).toBe('video')
    expect(previewKind(file('application/zip'))).toBe('unknown')
  })

  it('wraps gallery navigation in both directions', () => {
    expect(adjacentFileIndex(0, -1, 3)).toBe(2)
    expect(adjacentFileIndex(2, 1, 3)).toBe(0)
    expect(adjacentFileIndex(1, 1, 3)).toBe(2)
    expect(adjacentFileIndex(0, 1, 1)).toBe(0)
  })

  it('makes file chips open a dialog instead of downloading directly', () => {
    const html = renderToStaticMarkup(
      <MessageAttachments
        slug="demo"
        attachments={[
          file('text/plain', 'notes.txt'),
          { ...file('image/png', 'diagram.png'), id: 'attachment-2' },
        ]}
      />,
    )

    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('click to preview')
    expect(html).not.toContain('download=')
  })
})
