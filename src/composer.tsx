import { memo, useRef } from 'react'
import { ComposerPanel } from './composerPanel'
import { UsageReadout } from './usageReadout'
import type { TaskWithProject } from './types'
import type { ReplyDraft } from './useReplyDrafts'

// The reply bar under the open conversation: the task's draft and its
// attachments, sending, and the corner usage readout. The draft itself lives
// above (see useReplyDrafts), so closing the task doesn't lose it.
export const Composer = memo(function Composer({
  task,
  height,
  draft,
}: {
  task: TaskWithProject
  height: number
  draft: ReplyDraft
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
      onClearFiles={draft.clearFiles}
      showAttach={!task.archived}
      actions={<UsageReadout task={task} />}
    />
  )
})
