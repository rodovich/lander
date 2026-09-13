import { useCallback, useEffect, useMemo, useState } from 'react'
import { uiHeaders, uploadAttachments } from './api'
import { useSessionState } from './hooks'
import { migrateLegacyTaskValues, taskKeyOf } from './taskRef'
import type { TaskLink, TaskWithProject } from './types'

// The open task's reply in progress: what's typed, what's attached, whether it
// is on its way, and the moves that change them.
export type ReplyDraft = {
  text: string
  files: File[]
  sending: boolean
  setText: (text: string) => void
  addFiles: (picked: File[]) => void
  clearFiles: () => void
  // Uploads the files and posts the reply, then clears the draft. Settles once
  // the send has finished either way; a failure lands in the app's error line.
  send: () => Promise<void>
}

const NO_FILES: File[] = []

// Every task's reply draft, owned here — above the composer, which unmounts
// whenever no task is open — and handed out for the task that is. Drafts, files,
// and in-flight flags are keyed by project + task id, so a reply started in one
// task survives switching away and back without colliding with an equal id in
// another project. Typed text is session-scoped, surviving a reload in its tab;
// files can't be serialized and don't.
export function useReplyDrafts(
  task: TaskWithProject | null,
  {
    setError,
    refresh,
    taskLinks,
    taskLinksLoaded,
  }: {
    setError: (message: string | null) => void
    refresh: () => Promise<void>
    // The global task index, which proves which project a legacy draft's id
    // belongs to.
    taskLinks: TaskLink[]
    taskLinksLoaded: boolean
  },
): ReplyDraft | null {
  const [replies, setReplies] = useSessionState<Record<string, string>>(
    'lander:draft:replies',
    {},
  )
  const [sendingBy, setSendingBy] = useState<Record<string, boolean>>({})
  const [filesBy, setFilesBy] = useState<Record<string, File[]>>({})

  // Drafts saved by an older client were keyed only by id. Migrate one only
  // when the global projection proves that id belongs to exactly one project;
  // an ambiguous legacy draft is left untouched rather than guessed onto the
  // wrong task.
  useEffect(() => {
    if (!taskLinksLoaded) return
    setReplies((prev) => migrateLegacyTaskValues(prev, taskLinks))
  }, [taskLinks, taskLinksLoaded, setReplies])

  const id = task?.id
  const slug = task?.projectSlug
  const key = task ? taskKeyOf(task) : null
  const text = key ? (replies[key] ?? '') : ''
  const files = key ? (filesBy[key] ?? NO_FILES) : NO_FILES
  const sending = key ? (sendingBy[key] ?? false) : false

  const setText = useCallback(
    (value: string) => {
      if (key) setReplies((prev) => ({ ...prev, [key]: value }))
    },
    [key, setReplies],
  )
  const addFiles = useCallback(
    (picked: File[]) => {
      if (key)
        setFilesBy((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), ...picked] }))
    },
    [key],
  )
  const clearFiles = useCallback(() => {
    if (key) setFilesBy((prev) => ({ ...prev, [key]: [] }))
  }, [key])

  // Bound to the task open when it was pressed: switching away mid-send still
  // clears and un-flags the draft it was sending, not the one now open.
  const send = useCallback(async () => {
    if (!key || !id || !slug || !text.trim() || sending) return
    setSendingBy((prev) => ({ ...prev, [key]: true }))
    setError(null)
    try {
      const attachments = await uploadAttachments(slug, files)
      const r = await fetch(`/api/${slug}/tasks/${id}/messages`, {
        method: 'POST',
        headers: uiHeaders(),
        body: JSON.stringify({
          message: text,
          ...(attachments.length ? { attachments } : {}),
        }),
      })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? r.statusText)
      setReplies((prev) => ({ ...prev, [key]: '' }))
      setFilesBy((prev) => ({ ...prev, [key]: [] }))
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSendingBy((prev) => ({ ...prev, [key]: false }))
    }
  }, [key, id, slug, text, files, sending, setError, setReplies, refresh])

  return useMemo(
    () =>
      key
        ? { text, files, sending, setText, addFiles, clearFiles, send }
        : null,
    [key, text, files, sending, setText, addFiles, clearFiles, send],
  )
}
