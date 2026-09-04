import { forwardRef, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { formatBytes } from './format'
import type { Artifact, Attachment } from './types'

type PreviewFile = { file: Attachment; url: string }
type PreviewKind = 'image' | 'text' | 'pdf' | 'audio' | 'video' | 'unknown'

const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024
const TEXT_FILE_NAME =
  /(?:^|\.)(?:c|cc|cpp|css|diff|env|go|h|hpp|html|ini|java|js|jsx|log|mjs|patch|py|rb|rs|sh|sql|toml|ts|tsx|xml|ya?ml)$/i

// Fetching through JS is required because the UI token cannot be carried by a
// bare media or download URL. Blob URLs made from the response can be handed to
// the browser's native image, media, and PDF renderers afterward.
async function fetchBlob(url: string): Promise<Blob | null> {
  const token = import.meta.env.VITE_LANDER_UI_TOKEN
  const r = await fetch(url, {
    headers: token ? { 'x-lander-ui-token': token } : {},
  })
  return r.ok ? r.blob() : null
}

export function previewKind(file: Attachment): PreviewKind {
  const mime = file.mime.toLowerCase().split(';', 1)[0].trim()
  if (mime.startsWith('image/')) return 'image'
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

// The paperclip control shown below a composer opens the file browser, then
// shows the picked filename (single) or "N files" with an ✕ to clear. Its parent
// composer is the drop target; this holds only the hidden <input type=file>.
export function AttachButton({
  files,
  onAdd,
  onClear,
  disabled,
}: {
  files: File[]
  onAdd: (picked: File[]) => void
  onClear: () => void
  disabled?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <span className="attach">
      <button
        type="button"
        className="attach-btn"
        title="Attach files or drop them here"
        aria-label="Attach files"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon />
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="attach-input"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? [])
          if (picked.length) onAdd(picked)
          // Reset so re-picking the same file still fires onChange.
          e.target.value = ''
        }}
      />
      {files.length > 0 && (
        <span className="attach-info">
          <span className="attach-names" title={files.map((f) => f.name).join(', ')}>
            {files.length === 1 ? files[0].name : `${files.length} files`}
          </span>
          <button
            type="button"
            className="attach-clear"
            title="Clear attachments"
            aria-label="Clear attachments"
            disabled={disabled}
            onClick={onClear}
          >
            ✕
          </button>
        </span>
      )}
    </span>
  )
}

function PaperclipIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 0 1 4.24 4.24l-9.2 9.19a1 1 0 0 1-1.41-1.41l8.49-8.49"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// The attachments a user message carried, rendered as chips beside — never inside
// — the message text (the prompt manifest the agent sees is generated separately
// by the daemon and never stored in Message.text). Images additionally show a
// thumbnail; clicking any chip opens the message's attachment gallery.
export function MessageAttachments({
  attachments,
  slug,
}: {
  attachments: Attachment[]
  slug: string
}) {
  return (
    <FileGallery
      files={attachments.map((file) => ({
        file,
        url: `/api/${slug}/attachments/${file.id}`,
      }))}
    />
  )
}

// The artifacts (named output files) an assistant message published, rendered as
// the same chips at the bottom of that message. Each resolves its slot's blob by
// name from the task's artifact endpoint rather than by the ref's own blob id,
// which means a ref left by an earlier publish shows its own size against the
// latest bytes. Publishing no longer deletes the blob a republish displaces, so
// by-id would now resolve for anything published since — but refs recorded before
// that change name blobs that were already deleted, and by-id would 404 on them.
// The switch waits for the migration that drops those dead refs. Keyed by blob id
// so two refs of the same name don't collide.
export function MessageArtifacts({
  artifacts,
  taskId,
  slug,
}: {
  artifacts: Artifact[]
  taskId: string
  slug: string
}) {
  return (
    <FileGallery
      files={artifacts.map((file) => ({
        file,
        url: `/api/${slug}/tasks/${taskId}/artifacts/${encodeURIComponent(file.name)}`,
      }))}
    />
  )
}

// One modal is shared by all files in a message, so its arrows move within that
// message rather than across unrelated turns. A portal keeps the fixed backdrop
// out of the scrolling conversation's stacking and overflow contexts.
function FileGallery({ files }: { files: PreviewFile[] }) {
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
        {files.map(({ file, url }, index) => (
          <FileChip
            key={file.id}
            ref={(node) => {
              chipRefs.current[index] = node
            }}
            file={file}
            url={url}
            onOpen={() => setSelected(index)}
          />
        ))}
      </div>
      {active &&
        typeof document !== 'undefined' &&
        createPortal(
          <FilePreviewModal
            entry={active}
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

// A single file chip — shared by input attachments and output artifacts (an
// Artifact is structurally an Attachment plus timestamps). `file` supplies the
// display fields; `url` is the token-gated endpoint the bytes come from, which
// differs by kind (attachment-by-id vs artifact-by-name).
const FileChip = forwardRef<
  HTMLButtonElement,
  { file: Attachment; url: string; onOpen: () => void }
>(function FileChip({ file, url, onOpen }, ref) {
  const isImage = file.mime.toLowerCase().startsWith('image/')
  const [thumb, setThumb] = useState<string | null>(null)

  useEffect(() => {
    if (!isImage) return
    let obj: string | null = null
    let canceled = false
    void fetchBlob(url).then((b) => {
      if (b && !canceled) {
        obj = URL.createObjectURL(b)
        setThumb(obj)
      }
    }).catch(() => {})
    return () => {
      canceled = true
      if (obj) URL.revokeObjectURL(obj)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, isImage])

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
  entry,
  index,
  total,
  onClose,
  onMove,
}: {
  entry: PreviewFile
  index: number
  total: number
  onClose: () => void
  onMove: (direction: -1 | 1) => void
}) {
  const { file, url } = entry
  const kind = previewKind(file)
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

    void fetchBlob(url)
      .then(async (blob) => {
        if (!blob) throw new Error('fetch failed')
        const truncated = kind === 'text' && blob.size > MAX_TEXT_PREVIEW_BYTES
        const text = kind === 'text'
          ? await blob.slice(0, MAX_TEXT_PREVIEW_BYTES).text()
          : null
        if (canceled) return
        if (kind !== 'text' && kind !== 'unknown')
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
  }, [kind, url])

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
            ) : kind === 'text' ? (
              <div className="attachment-preview-text-wrap">
                <pre className="attachment-preview-text">{preview.text}</pre>
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
