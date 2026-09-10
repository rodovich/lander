import { memo, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { uiHeaders, uploadAttachments } from './api'
import { AttachButton } from './attachments'
import { clipboardImageFiles } from './fileDrop'
import { useFileDrop } from './hooks'
import { taskKeyOf } from './taskRef'
import { UsageReadout } from './usageReadout'
import type { TaskWithProject } from './types'

// The reply bar under the open conversation: the per-task drafts and their
// attachments, sending, and the corner usage readout. Drafts and in-flight
// state are keyed by project + task id so a reply started in one task survives
// switching away and back without colliding with an equal id in another project.
// The parent owns those maps so navigating away does not unmount their state.
export const Composer = memo(function Composer({
  task,
  height,
  setError,
  refresh,
  replies,
  setReplies,
  sendingBy,
  setSendingBy,
  replyFiles,
  setReplyFiles,
}: {
  task: TaskWithProject
  height: number
  setError: (message: string | null) => void
  refresh: () => Promise<void>
  replies: Record<string, string>
  setReplies: Dispatch<SetStateAction<Record<string, string>>>
  sendingBy: Record<string, boolean>
  setSendingBy: Dispatch<SetStateAction<Record<string, boolean>>>
  replyFiles: Record<string, File[]>
  setReplyFiles: Dispatch<SetStateAction<Record<string, File[]>>>
}) {
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const key = taskKeyOf(task)

  // The whole reply panel is one drop target, including its textarea,
  // paperclip, and surrounding action area. Keep the target bound to the
  // task currently open so switching tasks cannot leak a dropped file into
  // another task's draft.
  const replyDrop = useFileDrop<HTMLDivElement>(
    (picked) => {
      setReplyFiles((prev) => ({
        ...prev,
        [key]: [...(prev[key] ?? []), ...picked],
      }))
    },
    !!task.archived || (sendingBy[key] ?? false),
  )

  async function sendReply() {
    const id = task.id
    const proj = task.projectSlug
    const draft = replies[key] ?? ''
    if (!draft.trim() || sendingBy[key]) return
    setSendingBy((prev) => ({ ...prev, [key]: true }))
    setError(null)
    try {
      const attachments = await uploadAttachments(proj, replyFiles[key] ?? [])
      const r = await fetch(`/api/${proj}/tasks/${id}/messages`, {
        method: 'POST',
        headers: uiHeaders(),
        body: JSON.stringify({
          message: draft,
          ...(attachments.length ? { attachments } : {}),
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      setReplies((prev) => ({ ...prev, [key]: '' }))
      setReplyFiles((prev) => ({ ...prev, [key]: [] }))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSendingBy((prev) => ({ ...prev, [key]: false }))
      // Disabling the textarea while sending drops its focus; restore it once
      // the element re-enables so you can keep typing the next reply.
      requestAnimationFrame(() => composerRef.current?.focus())
    }
  }

  function onReplyKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Plain Enter sends; Shift+Enter / Option(Alt)+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      void sendReply()
    }
  }

  return (
    <div
      className={`composer-bar${replyDrop.active ? ' file-drop-active' : ''}`}
      style={{ height }}
      {...replyDrop.handlers}
    >
      <textarea
        ref={composerRef}
        className="composer"
        placeholder={task.archived ? 'Restore this task to reply' : 'Reply…'}
        rows={3}
        value={replies[key] ?? ''}
        disabled={(sendingBy[key] ?? false) || !!task.archived}
        onChange={(e) =>
          setReplies((prev) => ({
            ...prev,
            [key]: e.target.value,
          }))
        }
        onKeyDown={onReplyKeyDown}
        onPaste={(e) => {
          const images = clipboardImageFiles(e.clipboardData)
          if (images.length === 0) return
          e.preventDefault()
          setReplyFiles((prev) => ({
            ...prev,
            [key]: [...(prev[key] ?? []), ...images],
          }))
        }}
      />
      <div className="composer-actions">
        {!task.archived && (
          <AttachButton
            files={replyFiles[key] ?? []}
            onAdd={(picked) =>
              setReplyFiles((prev) => ({
                ...prev,
                [key]: [...(prev[key] ?? []), ...picked],
              }))
            }
            onClear={() =>
              setReplyFiles((prev) => ({ ...prev, [key]: [] }))
            }
            disabled={sendingBy[key] ?? false}
          />
        )}
        <UsageReadout task={task} />
      </div>
    </div>
  )
})
