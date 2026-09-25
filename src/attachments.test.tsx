import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  adjacentFileIndex,
  HTML_PREVIEW_SANDBOX,
  MessageAttachments,
  previewKind,
  sandboxedHtml,
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
    expect(previewKind(file('text/html; charset=utf-8'))).toBe('html')
    expect(previewKind(file('application/octet-stream', 'harness.html'))).toBe('html')
    expect(previewKind(file('text/plain', 'page.htm'))).toBe('html')
    expect(previewKind(file('text/markdown; charset=utf-8'))).toBe('markdown')
    expect(previewKind(file('application/octet-stream', 'README.md'))).toBe('markdown')
    expect(previewKind(file('text/plain', 'notes.markdown'))).toBe('markdown')
  })

  it('confines HTML previews to an opaque origin with no network', () => {
    expect(HTML_PREVIEW_SANDBOX).toBe('allow-scripts')
    const csp = /^<meta http-equiv="Content-Security-Policy" content="([^"]+)">/
    const bare = sandboxedHtml('<p>hi</p>')
    expect(bare).toMatch(csp)
    expect(bare.endsWith('<p>hi</p>')).toBe(true)
    const policy = csp.exec(bare)![1]
    expect(policy).toContain("default-src 'none'")
    expect(policy).not.toMatch(/https?:|'self'|\*/)
  })

  it('keeps a doctype ahead of the injected policy', () => {
    const out = sandboxedHtml('<!DOCTYPE html>\n<html><body>x</body></html>')
    expect(out.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true)
    expect(out.endsWith('\n<html><body>x</body></html>')).toBe(true)
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
