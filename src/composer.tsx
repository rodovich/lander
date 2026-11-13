import { memo, useRef, type ReactNode, type RefObject } from 'react'
import { ComposerPanel, type AttachFiles } from './composerPanel'
import { UsageReadout } from './usageReadout'
import type { TaskWithProject } from './types'
import type { ReplyDraft } from './useReplyDrafts'

// The reply bar under the open conversation: the task's draft and its
// attachments, sending, and, in the action row's right corner, the usage
// readout unless hidden and any controls passed in. The draft itself lives
// above (see useReplyDrafts), so closing the task doesn't lose it.
export const Composer = memo(function Composer({
  task,
  height,
  draft,
  showUsage = true,
  actions,
  attachRef,
}: {
  task: TaskWithProject
  height: number
  draft: ReplyDraft
  showUsage?: boolean
  actions?: ReactNode
  attachRef?: RefObject<AttachFiles | null>
}) {
  const composerRef = useRef<HTMLTextAreaElement>(null)

  return (
    <ComposerPanel
      className="composer-bar"
      height={height}
      value={draft.text}
      onChange={draft.setText}
      onSubmit={() =>
        void draft.send().then(() =>
          // Disabling the textarea while sending drops its focus; restore it
          // once the element re-enables so you can keep typing the next reply.
          requestAnimationFrame(() => composerRef.current?.focus()),
        )
      }
      placeholder={task.archived ? 'Restore this task to reply' : 'Reply…'}
      rows={3}
      textareaClassName="composer"
      textareaRef={composerRef}
      textareaDisabled={draft.sending || !!task.archived}
      busy={draft.sending || !!task.archived}
      files={draft.files}
      onAddFiles={draft.addFiles}
      onKeepFiles={draft.keepFiles}
      showAttach={!task.archived}
      actions={
        <>
          {showUsage && <UsageReadout task={task} />}
          {actions}
        </>
      }
      attachRef={attachRef}
    />
  )
})
