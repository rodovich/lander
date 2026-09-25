import { forwardRef, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { loadAttachment } from './api'
import { formatBytes } from './format'
import { Markdown } from './markdown'
import { useTaskLink } from './taskLinkContext'
import type { Attachment } from './types'

type PreviewKind =
  | 'image'
  | 'html'
  | 'markdown'
  | 'text'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'unknown'

// Where a gallery's bytes come from: a file's contents, or null when they
// can't be had. The gallery never learns what serves them. Its identity is an
// effect dependency, so a caller keeps it stable across renders.
type LoadFile = (file: Attachment) => Promise<Blob | null>

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024
const TEXT_FILE_NAME =
  /(?:^|\.)(?:c|cc|cpp|css|diff|env|go|h|hpp|ini|java|js|jsx|log|mjs|patch|py|rb|rs|sh|sql|toml|ts|tsx|xml|ya?ml)$/i
const HTML_FILE_NAME = /\.html?$/i
const MARKDOWN_FILE_NAME = /\.(?:md|markdown)$/i

export function previewKind(file: Attachment): PreviewKind {
  const mime = file.mime.toLowerCase().split(';', 1)[0].trim()
  if (mime.startsWith('image/')) return 'image'
  if (
    mime === 'text/html' ||
    mime === 'application/xhtml+xml' ||
    ((mime === 'application/octet-stream' || mime === 'text/plain') &&
      HTML_FILE_NAME.test(file.name))
  )
    return 'html'
  if (
    mime === 'text/markdown' ||
    mime === 'text/x-markdown' ||
    ((mime === 'application/octet-stream' || mime === 'text/plain') &&
      MARKDOWN_FILE_NAME.test(file.name))
  )
    return 'markdown'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (mime === 'application/pdf') return 'pdf'
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/ld+json' ||
    mime === 'application/javascript' ||
    mime === 'application/xml' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml') ||
    TEXT_FILE_NAME.test(file.name)
  )
    return 'text'
  return 'unknown'
}

// Agent-written HTML runs in an iframe sandboxed without `allow-same-origin`, so
// it gets an opaque origin and can't reach the lander page or its UI token. The
// CSP closes the network: the page can't load the dev server's modules (which
// carry the token) or call the API, so a preview must be one self-contained file.
// A meta CSP only takes effect ahead of the content it governs, so it goes first
// — after any doctype, which must stay first to keep the page out of quirks mode.
export const HTML_PREVIEW_SANDBOX = 'allow-scripts'
const HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data: blob:",
  'img-src data: blob:',
  'font-src data: blob:',
  'media-src data: blob:',
  'connect-src data: blob:',
  'worker-src data: blob:',
  'frame-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

export function sandboxedHtml(source: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`
  const doctype = /^﻿?\s*<!doctype[^>]*>/i.exec(source)
  return doctype
    ? doctype[0] + meta + source.slice(doctype[0].length)
    : meta + source
}

// Show an HTML preview in its own tab, for pages that need more room than the
// modal. The tab is a blank same-origin page holding only the sandboxed frame,
// cut loose from its opener once built.
function openHtmlInTab(name: string, source: string) {
  const tab = window.open('about:blank', '_blank')
  if (!tab) return
  const doc = tab.document
  doc.title = name
  doc.body.style.margin = '0'
  const frame = doc.createElement('iframe')
  frame.setAttribute('sandbox', HTML_PREVIEW_SANDBOX)
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.title = name
  frame.style.cssText = 'display:block;width:100vw;height:100vh;border:none;background:white'
  frame.srcdoc = sandboxedHtml(source)
  doc.body.appendChild(frame)
  tab.opener = null
}

export function adjacentFileIndex(
  index: number,
  direction: -1 | 1,
  total: number,
): number {
  if (total <= 1) return 0
  return (index + direction + total) % total
}

// Re-encode an image blob as PNG, the only format browsers reliably accept for
// clipboard writes. A PNG source is returned untouched; anything else is drawn
// to a canvas and exported.
async function toPng(b: Blob): Promise<Blob> {
  if (b.type === 'image/png') return b
  const bitmap = await createImageBitmap(b)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('toBlob failed'))), 'image/png'),
  )
}

// The attachments a message carried, rendered as chips beside — never inside —
// the message text (the prompt manifest the agent sees is generated separately by
// the daemon and never stored in the item's text). Images additionally show a
// thumbnail; clicking any chip opens the message's attachment gallery.
export function MessageAttachments({
  attachments,
  slug,
}: {
  attachments: Attachment[]
  slug: string
}) {
  const load = useCallback(
    (file: Attachment) => loadAttachment(slug, file.id),
    [slug],
  )
  return <FileGallery files={attachments} load={load} />
}

// A row of file chips that open into a shared preview modal. One modal serves
// all the files in the row, so its arrows move within that row rather than
// across unrelated turns. A portal keeps the fixed backdrop out of the
// scrolling conversation's stacking and overflow contexts.
function FileGallery({ files, load }: { files: Attachment[]; load: LoadFile }) {
  const [selected, setSelected] = useState<number | null>(null)
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([])
  const active = selected === null ? null : files[selected]

  useEffect(() => {
    if (selected !== null && !active) setSelected(null)
  }, [active, selected])

  const close = () => {
    const opener = selected === null ? null : chipRefs.current[selected]
    setSelected(null)
    requestAnimationFrame(() => opener?.focus())
  }
  const move = (direction: -1 | 1) =>
    setSelected((index) =>
      index === null ? null : adjacentFileIndex(index, direction, files.length),
    )

  return (
    <>
      <div className="message-attachments">
        {files.map((file, index) => (
          <FileChip
            key={file.id}
            ref={(node) => {
              chipRefs.current[index] = node
            }}
            file={file}
            load={load}
            onOpen={() => setSelected(index)}
          />
        ))}
      </div>
      {active &&
        typeof document !== 'undefined' &&
        createPortal(
          <FilePreviewModal
            file={active}
            load={load}
            index={selected!}
            total={files.length}
            onClose={close}
            onMove={move}
          />,
          document.body,
        )}
    </>
  )
}

const FileChip = forwardRef<
  HTMLButtonElement,
  { file: Attachment; load: LoadFile; onOpen: () => void }
>(function FileChip({ file, load, onOpen }, ref) {
  const isImage = file.mime.toLowerCase().startsWith('image/')
  const [thumb, setThumb] = useState<string | null>(null)

  useEffect(() => {
    if (!isImage) return
    let obj: string | null = null
    let canceled = false
    void load(file).then((b) => {
      if (b && !canceled) {
        obj = URL.createObjectURL(b)
        setThumb(obj)
      }
    }).catch(() => {})
    return () => {
      canceled = true
      if (obj) URL.revokeObjectURL(obj)
    }
    // Keyed on the file's id, not the object: a poll hands over a fresh copy of
    // the same file every 2s, and re-fetching its thumbnail each time would flicker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, isImage, load])

  return (
    <button
      ref={ref}
      type="button"
      className={`attachment-chip${isImage ? ' attachment-chip-image' : ''}`}
      aria-haspopup="dialog"
      onClick={onOpen}
      title={`${file.name} — ${formatBytes(file.size)} (click to preview)`}
    >
      {isImage && thumb ? (
        <img className="attachment-thumb" src={thumb} alt={file.name} />
      ) : (
        <span className="attachment-chip-icon" aria-hidden>
          {isImage ? '🖼' : '📄'}
        </span>
      )}
      <span className="attachment-chip-meta">
        <span className="attachment-chip-name">{file.name}</span>
        <span className="attachment-chip-size">{formatBytes(file.size)}</span>
      </span>
    </button>
  )
})

function FilePreviewModal({
  file,
  load,
  index,
  total,
  onClose,
  onMove,
}: {
  file: Attachment
  load: LoadFile
  index: number
  total: number
  onClose: () => void
  onMove: (direction: -1 | 1) => void
}) {
  const kind = previewKind(file)
  const linkTask = useTaskLink()
  const titleId = useId()
  const modalRef = useRef<HTMLDivElement>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [copied, setCopied] = useState(false)
  const [preview, setPreview] = useState<{
    status: 'loading' | 'ready' | 'error'
    blob: Blob | null
    objectUrl: string | null
    text: string | null
    truncated: boolean
  }>({
    status: 'loading',
    blob: null,
    objectUrl: null,
    text: null,
    truncated: false,
  })

  useEffect(() => {
    modalRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        const focusable = Array.from(
          modalRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), audio[controls], video[controls], iframe',
          ) ?? [],
        )
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (!first || !last) return
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === modalRef.current)
        )
          last.focus()
        else if (!event.shiftKey && document.activeElement === last) first.focus()
        else return
      } else if (event.key === 'Escape') onClose()
      else if (event.target instanceof HTMLMediaElement) return
      else if (event.key === 'ArrowLeft' && total > 1) onMove(-1)
      else if (event.key === 'ArrowRight' && total > 1) onMove(1)
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onMove, total])

  useEffect(() => {
    let canceled = false
    let objectUrl: string | null = null
    setPreview({
      status: 'loading',
      blob: null,
      objectUrl: null,
      text: null,
      truncated: false,
    })
    setCopied(false)
    if (copyTimer.current) clearTimeout(copyTimer.current)

    void load(file)
      .then(async (blob) => {
        if (!blob) throw new Error('fetch failed')
        const isText = kind === 'text' || kind === 'markdown'
        const truncated = isText && blob.size > MAX_TEXT_PREVIEW_BYTES
        const text = isText
          ? await blob.slice(0, MAX_TEXT_PREVIEW_BYTES).text()
          : kind === 'html'
            ? await blob.text()
            : null
        if (canceled) return
        if (!isText && kind !== 'html' && kind !== 'unknown')
          objectUrl = URL.createObjectURL(blob)
        setPreview({ status: 'ready', blob, objectUrl, text, truncated })
      })
      .catch(() => {
        if (!canceled)
          setPreview({
            status: 'error',
            blob: null,
            objectUrl: null,
            text: null,
            truncated: false,
          })
      })

    return () => {
      canceled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    // Keyed on the file's id for the same reason the chip's thumbnail is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, file.id, load])

  useEffect(
    () => () => {
      if (copyTimer.current) clearTimeout(copyTimer.current)
    },
    [],
  )

  const download = () => {
    if (!preview.objectUrl && !preview.blob) return
    const temporaryUrl = preview.objectUrl ? null : URL.createObjectURL(preview.blob!)
    const link = document.createElement('a')
    link.href = preview.objectUrl ?? temporaryUrl!
    link.download = file.name
    document.body.appendChild(link)
    link.click()
    link.remove()
    if (temporaryUrl) setTimeout(() => URL.revokeObjectURL(temporaryUrl), 0)
  }

  const copy = async () => {
    if (!preview.blob) return
    try {
      if (
        kind === 'image' &&
        navigator.clipboard &&
        'write' in navigator.clipboard &&
        typeof ClipboardItem !== 'undefined'
      ) {
        // Clipboard writes must begin during the click's user activation. The
        // API accepts a pending PNG promise, so conversion may finish afterward.
        const png = toPng(preview.blob)
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      } else {
        await navigator.clipboard.writeText(await preview.blob.text())
      }
      setCopied(true)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied in an insecure context or by the browser.
    }
  }

  return (
    <div
      className="attachment-preview-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={modalRef}
        className="attachment-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="attachment-preview-head">
          <div className="attachment-preview-heading">
            <span id={titleId} className="attachment-preview-name" title={file.name}>
              {file.name}
            </span>
            <span className="attachment-preview-count">
              {index + 1} of {total}
            </span>
          </div>
          <button
            type="button"
            className="attachment-preview-close"
            aria-label="Close preview"
            title="Close preview"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="attachment-preview-content">
          <button
            type="button"
            className="attachment-preview-arrow"
            aria-label="Previous attachment"
            title="Previous attachment"
            disabled={total <= 1}
            onClick={() => onMove(-1)}
          >
            ‹
          </button>
          <div className="attachment-preview-viewport">
            {preview.status === 'loading' ? (
              <div className="attachment-preview-status">
                <span className="spinner" aria-hidden />
                Loading preview…
              </div>
            ) : preview.status === 'error' ? (
              <div className="attachment-preview-status">Preview could not be loaded.</div>
            ) : kind === 'image' ? (
              <img
                className="attachment-preview-image"
                src={preview.objectUrl!}
                alt={file.name}
              />
            ) : kind === 'html' ? (
              <iframe
                className="attachment-preview-document"
                sandbox={HTML_PREVIEW_SANDBOX}
                referrerPolicy="no-referrer"
                srcDoc={sandboxedHtml(preview.text!)}
                title={file.name}
              />
            ) : kind === 'pdf' ? (
              <iframe
                className="attachment-preview-document"
                src={preview.objectUrl!}
                title={file.name}
              />
            ) : kind === 'video' ? (
              <video className="attachment-preview-video" src={preview.objectUrl!} controls />
            ) : kind === 'audio' ? (
              <audio className="attachment-preview-audio" src={preview.objectUrl!} controls />
            ) : kind === 'text' || kind === 'markdown' ? (
              <div className="attachment-preview-text-wrap">
                {kind === 'markdown' ? (
                  <div className="attachment-preview-markdown message-text">
                    <Markdown text={preview.text!} linkTask={linkTask} />
                  </div>
                ) : (
                  <pre className="attachment-preview-text">{preview.text}</pre>
                )}
                {preview.truncated && (
                  <div className="attachment-preview-truncated">
                    Preview limited to the first {formatBytes(MAX_TEXT_PREVIEW_BYTES)}.
                  </div>
                )}
              </div>
            ) : (
              <div className="attachment-preview-unknown">
                <span className="attachment-preview-file-icon" aria-hidden>
                  📄
                </span>
                <span>No preview is available for this file type.</span>
              </div>
            )}
          </div>
          <button
            type="button"
            className="attachment-preview-arrow"
            aria-label="Next attachment"
            title="Next attachment"
            disabled={total <= 1}
            onClick={() => onMove(1)}
          >
            ›
          </button>
        </div>

        <div className="attachment-preview-foot">
          <span className="attachment-preview-meta">
            {formatBytes(file.size)} · {file.mime}
          </span>
          <div className="attachment-preview-actions">
            {kind === 'html' && (
              <button
                type="button"
                disabled={preview.text === null}
                onClick={() => openHtmlInTab(file.name, preview.text!)}
              >
                Open in tab
              </button>
            )}
            <button type="button" disabled={!preview.blob} onClick={() => void copy()}>
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
            <button type="button" disabled={!preview.blob} onClick={download}>
              Download
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
