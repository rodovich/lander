// The durable attachment blob store (server side). Each attachment persists as a
// `<id>` blob file plus an `<id>.json` metadata sidecar in the project's
// attachmentsDir. Kept free of the server's HTTP wiring so it can be unit-tested
// against a temp dir; index.ts binds these to the endpoints.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

// The public shape shared by the message record, the daemon manifest, and
// `lander file ls`. Just enough to identify and size a file — never the bytes.
export type Attachment = { id: string; name: string; mime: string; size: number }

// Cap a single upload so a runaway file can't exhaust the daemon's disk when it
// materializes, nor bloat the server data dir. 25 MiB comfortably covers photos
// and data files while staying well under memory-per-request limits.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

// A path-safe attachment id: same closed alphabet as a task id (no `/`, `.`), so
// it can be a filename segment on both the server store and the daemon-local dir.
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,64}$/
export function isAttachmentId(id: unknown): id is string {
  return typeof id === 'string' && ATTACHMENT_ID.test(id)
}

// Strip a client-supplied filename down to a safe, display-only basename: drop
// any directory components and control chars, cap the length. The name is never
// used to build a store path (the id is), so this is purely cosmetic hygiene.
export function sanitizeName(name: unknown): string {
  const base = typeof name === 'string' ? path.basename(name) : ''
  // Drop ASCII control characters (incl. NUL/newlines); path.basename already
  // stripped any directory components.
  const cleaned = [...base]
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join('')
    .trim()
  return (cleaned || 'file').slice(0, 255)
}

function metaFile(dir: string, id: string): string {
  return path.join(dir, `${id}.json`)
}
function blobFile(dir: string, id: string): string {
  return path.join(dir, id)
}

export class AttachmentTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(
      `attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit (${size} bytes)`,
    )
    this.name = 'AttachmentTooLargeError'
  }
}

// Persist an uploaded blob: mint an id, write the bytes and a metadata sidecar,
// return the ref. Throws AttachmentTooLargeError on an over-size upload (the
// caller maps it to a 413).
export async function saveAttachment(
  attachmentsDir: string,
  input: { name: unknown; mime: unknown; bytes: Uint8Array },
): Promise<Attachment> {
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES)
    throw new AttachmentTooLargeError(input.bytes.byteLength)
  const id = randomUUID()
  const meta: Attachment = {
    id,
    name: sanitizeName(input.name),
    mime:
      typeof input.mime === 'string' && input.mime.trim()
        ? input.mime.trim().slice(0, 255)
        : 'application/octet-stream',
    size: input.bytes.byteLength,
  }
  await mkdir(attachmentsDir, { recursive: true })
  await writeFile(blobFile(attachmentsDir, id), input.bytes)
  await writeFile(metaFile(attachmentsDir, id), JSON.stringify(meta, null, 2))
  return meta
}

// Read an attachment's metadata sidecar, or null if it's missing/unreadable —
// the existence probe the endpoints and message-association path use to reject
// unknown ids.
export async function readAttachmentMeta(
  attachmentsDir: string,
  id: string,
): Promise<Attachment | null> {
  if (!isAttachmentId(id)) return null
  try {
    const raw = await readFile(metaFile(attachmentsDir, id), 'utf8')
    return JSON.parse(raw) as Attachment
  } catch {
    return null
  }
}

// Read an attachment's raw bytes, or null if it's missing. Serves the GET
// download endpoint (browser + daemon).
export async function readAttachmentBytes(
  attachmentsDir: string,
  id: string,
): Promise<Buffer | null> {
  if (!isAttachmentId(id)) return null
  try {
    return await readFile(blobFile(attachmentsDir, id))
  } catch {
    return null
  }
}
