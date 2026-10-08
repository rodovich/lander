import { CopyButton } from './copyButton'
import { useAnchoredPopup } from './hooks'
import type { ChangedFile, CheckoutReport } from './types'

function BranchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <circle cx="4.5" cy="3.5" r="1.6" />
        <circle cx="4.5" cy="12.5" r="1.6" />
        <circle cx="11.5" cy="5.5" r="1.6" />
        <path d="M4.5 5.1v5.8M11.5 7.1c0 2.4-2 3-5.4 4" />
      </g>
    </svg>
  )
}

// A commit on a line with nothing branching off it.
function DetachedIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <circle cx="8" cy="8" r="2.4" />
        <path d="M1.5 8h4M10.5 8h4" />
      </g>
    </svg>
  )
}

function totals(files: ChangedFile[]) {
  let added = 0
  let removed = 0
  for (const f of files) {
    added += f.added ?? 0
    removed += f.removed ?? 0
  }
  return { added, removed }
}

function DiffStat({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null || removed === null) return <span className="diffstat-binary">binary</span>
  return (
    <>
      <span className="diffstat-added">+{added}</span>
      <span className="diffstat-removed">−{removed}</span>
    </>
  )
}

// The task's worktree as of its last turn.
export function CheckoutChip({ checkout }: { checkout: CheckoutReport }) {
  const { open, setOpen, containerRef, triggerRef, popupRef, popupStyle } =
    useAnchoredPopup({ gap: 4 })
  const { path, branch, files } = checkout
  const sum = totals(files)
  const fileCount = `${files.length} ${files.length === 1 ? 'file' : 'files'}`

  return (
    <div className="checkout" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="checkout-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Worktree"
        onClick={() => setOpen((o) => !o)}
      >
        {branch ? <BranchIcon /> : <DetachedIcon />}
        <span className="checkout-branch">{branch ?? 'detached'}</span>
        {files.length > 0 && (
          <>
            <span>{fileCount}</span>
            <DiffStat {...sum} />
          </>
        )}
      </button>
      {open && (
        <div ref={popupRef} className="checkout-popup" role="dialog" style={popupStyle}>
          <div className="checkout-popup-section checkout-fields">
            <span className="checkout-label">Worktree</span>
            <code className="checkout-value" title={path}>
              {path}
            </code>
            <CopyButton text={path} label="Copy worktree path" className="title-action" size={13} />
            <span className="checkout-label">Branch</span>
            {branch ? (
              <>
                <code className="checkout-value" title={branch}>
                  {branch}
                </code>
                <CopyButton
                  text={branch}
                  label="Copy branch name"
                  className="title-action"
                  size={13}
                />
              </>
            ) : (
              <span className="checkout-value checkout-detached">detached</span>
            )}
          </div>
          <div className="checkout-popup-section">
            {files.length ? (
              <div className="checkout-files">
                <span className="checkout-files-head">{fileCount} changed</span>
                <DiffStat {...sum} />
                {files.map((f) => (
                  <FileRow key={f.path} file={f} />
                ))}
              </div>
            ) : (
              <span className="checkout-files-head">No changes</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function FileRow({ file }: { file: ChangedFile }) {
  const slash = file.path.lastIndexOf('/') + 1
  return (
    <>
      <code className="checkout-file" title={file.path}>
        <span className="checkout-dir">{file.path.slice(0, slash)}</span>
        {file.path.slice(slash)}
      </code>
      <DiffStat added={file.added} removed={file.removed} />
    </>
  )
}
