import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { AttachButton } from './attachButton'
import {
  insertAttachmentMarkers,
  removeAttachmentMarkers,
  shouldAttachPastedText,
} from './composerAttachments'
import { clipboardImageFiles } from './fileDrop'
import { useFileDrop } from './hooks'

type DraftSelection = { text: string; start: number; end: number }

// The shell both composers wear — the reply bar under a conversation and the
// new-task form in the sidebar. It owns the interactions the two share and must
// not drift apart on: the whole panel is one file-drop target, a plain Enter
// submits while Shift/Option+Enter inserts a newline, pasted images become
// attachments that ⌘Z takes back, and the paperclip sits at the left of the
// action row. What differs is passed in — the element and its class, the
// header above the textarea, what holds the action row's right corner, and
// where the draft and its files live, since one composer keys them by task and
// the other doesn't.
export function ComposerPanel({
  as: Tag = 'div',
  className,
  height,
  head,
  actions,
  value,
  onChange,
  onSubmit,
  placeholder,
  rows,
  textareaClassName,
  textareaRef,
  textareaDisabled,
  busy,
  files,
  onAddFiles,
  onKeepFiles,
  showAttach = true,
}: {
  // A form when submitting is the panel's purpose (the new-task form's Launch
  // button is its submit), a plain div otherwise.
  as?: 'div' | 'form'
  className: string
  // Set by the drag handle above the panel; the region above absorbs the rest.
  height: number
  // Above the textarea: the new-task form's title and its pickers.
  head?: React.ReactNode
  // The action row's right corner: the usage readout, or the Launch button.
  actions?: React.ReactNode
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  placeholder: string
  rows: number
  textareaClassName?: string
  textareaRef?: RefObject<HTMLTextAreaElement | null>
  textareaDisabled?: boolean
  // Work is in flight: no dropping, pasting, or attaching onto a panel that is
  // mid-send. Whether the textarea itself locks is `textareaDisabled` — the
  // reply bar locks, the new-task form keeps taking the next draft.
  busy?: boolean
  files: File[]
  onAddFiles: (picked: File[]) => void
  onKeepFiles: (count: number) => void
  // Hidden where there is nothing to attach to — an archived task.
  showAttach?: boolean
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const ordinaryPaste = useRef(false)
  const pendingSelection = useRef<DraftSelection | null>(null)
  // What ⌘Z restores after attaching: the draft before, with the range the
  // markers replaced selected, and the draft after, to tell whether anything
  // has changed it since. The browser's own undo never sees these, since each
  // replaces the textarea's value outright.
  const insertions = useRef<
    { before: DraftSelection; keepFiles: number; after: string; files: number }[]
  >([])

  useLayoutEffect(() => {
    const pending = pendingSelection.current
    pendingSelection.current = null
    if (pending?.text === value && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.setSelectionRange(pending.start, pending.end)
    }
  }, [value, files])

  function addFiles(picked: File[], replaceSelection = false) {
    if (busy || textareaDisabled || !showAttach || picked.length === 0) return
    const input = inputRef.current
    const start = input?.selectionStart ?? value.length
    const end = (replaceSelection ? input?.selectionEnd : input?.selectionStart) ?? value.length
    const insertion = insertAttachmentMarkers(value, start, end, files.length, picked.length)
    pendingSelection.current = { text: insertion.text, start: insertion.caret, end: insertion.caret }
    insertions.current.push({
      before: { text: value, start, end },
      keepFiles: files.length,
      after: insertion.text,
      files: files.length + picked.length,
    })
    onAddFiles(picked)
    onChange(insertion.text)
  }

  function undoInsertion(): boolean {
    const last = insertions.current.pop()
    if (!last || last.after !== value || last.files !== files.length) {
      insertions.current = []
      return false
    }
    pendingSelection.current = last.before
    onKeepFiles(last.keepFiles)
    onChange(last.before.text)
    return true
  }

  const drop = useFileDrop<HTMLElement>(addFiles, busy || textareaDisabled || !showAttach)

  return (
    <Tag
      className={`${className}${drop.active ? ' file-drop-active' : ''}`}
      style={{ height }}
      onSubmit={
        Tag === 'form'
          ? (e: React.FormEvent) => {
              e.preventDefault()
              onSubmit()
            }
          : undefined
      }
      {...drop.handlers}
    >
      {head}
      <textarea
        ref={(element) => {
          inputRef.current = element
          if (textareaRef) textareaRef.current = element
        }}
        className={textareaClassName}
        placeholder={placeholder}
        rows={rows}
        value={value}
        disabled={textareaDisabled}
        onChange={(e) => {
          insertions.current = []
          onChange(e.target.value)
        }}
        onKeyDown={(e) => {
          const plainShortcut = (letter: string) =>
            (e.code === `Key${letter}` || e.key.toLowerCase() === letter.toLowerCase()) &&
            (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
          ordinaryPaste.current = plainShortcut('V')
          if (plainShortcut('Z') && undoInsertion()) {
            e.preventDefault()
            return
          }
          // Plain Enter submits; Shift+Enter / Option(Alt)+Enter inserts a newline.
          if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
            e.preventDefault()
            onSubmit()
          }
        }}
        onKeyUp={() => { ordinaryPaste.current = false }}
        onBlur={() => { ordinaryPaste.current = false }}
        onPointerDown={() => { ordinaryPaste.current = false }}
        onContextMenu={() => { ordinaryPaste.current = false }}
        onPaste={(e) => {
          const convertText = ordinaryPaste.current
          ordinaryPaste.current = false
          if (busy || textareaDisabled || !showAttach) return
          const images = clipboardImageFiles(e.clipboardData)
          if (images.length > 0) {
            e.preventDefault()
            addFiles(images, true)
            return
          }
          const text = e.clipboardData.getData('text/plain')
          if (convertText && shouldAttachPastedText(text)) {
            e.preventDefault()
            const number = files.length + 1
            addFiles([new File([text], number === 1 ? 'paste.txt' : `paste-${number}.txt`, {
              type: 'text/plain',
            })], true)
          }
        }}
      />
      <div className="composer-actions">
        {showAttach && (
          <AttachButton
            files={files}
            onAdd={addFiles}
            onClear={() => {
              insertions.current = []
              onKeepFiles(0)
              onChange(removeAttachmentMarkers(value, files.length))
            }}
            disabled={busy}
          />
        )}
        {actions}
      </div>
    </Tag>
  )
}
