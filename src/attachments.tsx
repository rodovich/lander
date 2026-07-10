import { useEffect, useRef, useState } from 'react'
import { formatBytes } from './format'
import type { Artifact, Attachment } from './types'

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
// thumbnail; clicking any chip downloads the original.
export function MessageAttachments({
  attachments,
  slug,
}: {
  attachments: Attachment[]
  slug: string
}) {
  return (
    <div className="message-attachments">
      {attachments.map((a) => (
        <FileChip key={a.id} file={a} url={`/api/${slug}/attachments/${a.id}`} />
      ))}
    </div>
  )
}

// The artifacts (named output files) an assistant message published, rendered as
// the same chips at the bottom of that message. Each downloads its slot's blob by
// name from the task's artifact endpoint — not by the ref's blob id, since a
// republish deletes the superseded blob, so only the by-name route is guaranteed
// to resolve (it serves the latest version). Keyed by blob id so two refs of the
// same name (a republish within one turn) don't collide.
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
    <div className="message-attachments">
      {artifacts.map((a) => (
        <FileChip
          key={a.id}
          file={a}
          url={`/api/${slug}/tasks/${taskId}/artifacts/${encodeURIComponent(a.name)}`}
        />
      ))}
    </div>
  )
}

// A single downloadable file chip — shared by input attachments and output
// artifacts (an Artifact is structurally an Attachment plus timestamps). `file`
// supplies the display fields; `url` is the token-gated endpoint the bytes come
// from, which differs by kind (attachment-by-id vs artifact-by-name). Images show
// a thumbnail; any chip downloads on click.
function FileChip({ file, url }: { file: Attachment; url: string }) {
  const isImage = file.mime.startsWith('image/')
  const [thumb, setThumb] = useState<string | null>(null)

  // The endpoint wants the UI token, which a bare <img src>/<a href> can't send,
  // so fetch the bytes with the header and hand back a blob URL. Used for the
  // image thumbnail and revoked on unmount.
  async function fetchBlob(): Promise<Blob | null> {
    const token = import.meta.env.VITE_LANDER_UI_TOKEN
    const r = await fetch(url, {
      headers: token ? { 'x-lander-ui-token': token } : {},
    })
    return r.ok ? r.blob() : null
  }

  useEffect(() => {
    if (!isImage) return
    let obj: string | null = null
    let cancelled = false
    void fetchBlob().then((b) => {
      if (b && !cancelled) {
        obj = URL.createObjectURL(b)
        setThumb(obj)
      }
    })
    return () => {
      cancelled = true
      if (obj) URL.revokeObjectURL(obj)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, isImage])

  async function download() {
    const b = await fetchBlob()
    if (!b) return
    const obj = URL.createObjectURL(b)
    const link = document.createElement('a')
    link.href = obj
    link.download = file.name
    link.click()
    URL.revokeObjectURL(obj)
  }

  return (
    <button
      type="button"
      className={`attachment-chip${isImage ? ' attachment-chip-image' : ''}`}
      onClick={() => void download()}
      title={`${file.name} — ${formatBytes(file.size)} (click to download)`}
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
}
