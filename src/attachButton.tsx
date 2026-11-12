import { useRef } from 'react'
import { CloseIcon, IconButton } from './iconButton'

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
      <IconButton
        label="Attach files"
        title="Attach files or drop them here"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon />
      </IconButton>
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
          <IconButton
            compact
            label="Clear attachments"
            disabled={disabled}
            onClick={onClear}
          >
            <CloseIcon size={12} />
          </IconButton>
        </span>
      )}
    </span>
  )
}

function PaperclipIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
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
