import { memo, useRef, useState } from 'react'
import { uiHeaders, uploadAttachments } from './api'
import { AttachButton } from './attachments'
import { clipboardImageFiles } from './fileDrop'
import { useFileDrop, usePersistentState, useSessionState } from './hooks'
import {
  latestUsage,
  taskUsageTelemetry,
  totalUsage,
} from './taskMeta'
import { TelemetryItemView } from './telemetry'
import type { TaskWithProject } from './types'

// The reply bar under the open conversation: the per-task drafts and their
// attachments, sending, and the corner usage readout. Drafts and in-flight
// state are keyed by task id so a reply started in one task survives switching
// away and back — which is why this component takes the task as a prop rather
// than remounting per task.
export const Composer = memo(function Composer({
  task,
  height,
  setError,
  refresh,
}: {
  task: TaskWithProject
  height: number
  setError: (message: string | null) => void
  refresh: () => Promise<void>
}) {
  // Each task keeps its own draft and in-flight state, keyed by id, so you
  // can start a reply in one task, switch away, and come back to finish it; the
  // drafts persist across reloads alongside the new-task message and, like it,
  // are session-scoped so two tabs don't clobber each other's reply drafts.
  const [replies, setReplies] = useSessionState<Record<string, string>>(
    'lander:draft:replies',
    {},
  )
  const [sendingBy, setSendingBy] = useState<Record<string, boolean>>({})
  const composerRef = useRef<HTMLTextAreaElement>(null)

  // Files attached to per-task replies, held as File objects (not
  // session-persisted — File isn't serializable) and uploaded to the durable
  // store on submit. The paperclip <AttachButton> owns its own hidden file
  // input.
  const [replyFiles, setReplyFiles] = useState<Record<string, File[]>>({})

  // Whether the corner usage readout sums across the whole task or shows just
  // the latest turn. Clicking it toggles; persisted so the choice sticks.
  const [usageTotal, setUsageTotal] = usePersistentState(
    'lander:usageTotal',
    false,
  )

  // The whole reply panel is one drop target, including its textarea,
  // paperclip, and surrounding action area. Keep the target bound to the
  // task currently open so switching tasks cannot leak a dropped file into
  // another task's draft.
  const replyDrop = useFileDrop<HTMLDivElement>(
    (picked) => {
      const id = task.id
      setReplyFiles((prev) => ({
        ...prev,
        [id]: [...(prev[id] ?? []), ...picked],
      }))
    },
    !!task.archived || (sendingBy[task.id] ?? false),
  )

  async function sendReply() {
    const id = task.id
    const proj = task.projectSlug
    const draft = replies[id] ?? ''
    if (!draft.trim() || sendingBy[id]) return
    setSendingBy((prev) => ({ ...prev, [id]: true }))
    setError(null)
    try {
      const attachments = await uploadAttachments(proj, replyFiles[id] ?? [])
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
      setReplies((prev) => ({ ...prev, [id]: '' }))
      setReplyFiles((prev) => ({ ...prev, [id]: [] }))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSendingBy((prev) => ({ ...prev, [id]: false }))
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
        value={replies[task.id] ?? ''}
        disabled={(sendingBy[task.id] ?? false) || !!task.archived}
        onChange={(e) =>
          setReplies((prev) => ({
            ...prev,
            [task.id]: e.target.value,
          }))
        }
        onKeyDown={onReplyKeyDown}
        onPaste={(e) => {
          const images = clipboardImageFiles(e.clipboardData)
          if (images.length === 0) return
          e.preventDefault()
          const id = task.id
          setReplyFiles((prev) => ({
            ...prev,
            [id]: [...(prev[id] ?? []), ...images],
          }))
        }}
      />
      <div className="allow-row">
        {!task.archived && (
          <AttachButton
            files={replyFiles[task.id] ?? []}
            onAdd={(picked) =>
              setReplyFiles((prev) => ({
                ...prev,
                [task.id]: [...(prev[task.id] ?? []), ...picked],
              }))
            }
            onClear={() =>
              setReplyFiles((prev) => ({ ...prev, [task.id]: [] }))
            }
            disabled={sendingBy[task.id] ?? false}
          />
        )}
        {(() => {
          const u = usageTotal ? totalUsage(task) : latestUsage(task)
          if (!u) return null
          const scope = usageTotal ? 'total' : 'turn'
          // Absent on legacy payloads / fixtures without an agent — treat
          // as cost-reporting (claude), matching the grants "fully capable"
          // default.
          const reportsCost = task.reportsCost ?? true
          const costText =
            u.costUsd !== undefined
              ? `$${u.costUsd.toFixed(4)}`
              : reportsCost
                ? '… (available when the turn lands)'
                : 'unavailable for Codex'
          const items = taskUsageTelemetry(u, task.agent, reportsCost)
          // The model names the whole task, not a scope, so it sits outside
          // the turn/total toggle; the counts + cost are what the toggle flips.
          const model = items.find((i) => i.id === 'model')
          const stats = items.filter((i) => i.id !== 'model')
          return (
            <div className="telemetry-inline">
              {model && <TelemetryItemView item={model} />}
              <button
                type="button"
                className="telemetry-toggle"
                onClick={() => setUsageTotal((v) => !v)}
                title={
                  `${scope} — click to show ` +
                  `${usageTotal ? 'turn' : 'total'}\n` +
                  `uncached input ${u.input.toLocaleString()} ` +
                  `(+ ${u.cacheCreation.toLocaleString()} written to cache)\n` +
                  `cache read ${u.cacheRead.toLocaleString()}\n` +
                  // The turn's cache-miss diagnostic, when the API reported
                  // one (per-turn only; misses don't sum).
                  (!usageTotal && u.cacheMiss
                    ? `cache miss: ${u.cacheMiss.reason.replaceAll('_', ' ')} ` +
                      `(${u.cacheMiss.missedTokens.toLocaleString()} tokens missed)\n`
                    : '') +
                  `output ${u.output.toLocaleString()}\n` +
                  `cost ${costText}`
                }
              >
                <span className="telemetry-scope">{scope}</span>
                {stats.map((item) => (
                  <TelemetryItemView key={item.id} item={item} />
                ))}
              </button>
            </div>
          )
        })()}
      </div>
    </div>
  )
})
