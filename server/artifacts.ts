// The artifact model: a task's named output slots (latest version only) and the
// pure helpers over them. An artifact is a named slot pointing at one blob in the
// project's attachment store (server/attachments.ts) — publishing to the same
// name mints a fresh blob and supersedes the old one. Kept free of HTTP/store
// wiring so it can be unit-tested; index.ts binds it to the endpoints and the
// blob store, and tasks.ts records the ref on the generating message.

import type { Attachment } from './attachments'

// A published output slot on a task: latest version only. `id` is the current
// blob in the attachment store; `name` is the addressable slot key (it appears in
// the download route and as the download filename), stable across republishes
// while `id` rotates. `createdAt` is the slot's first publish, `updatedAt` its
// most recent.
export type Artifact = {
  name: string
  id: string
  mime: string
  size: number
  createdAt: string
  updatedAt: string
}

// Cap a single artifact at 100 MiB — separate from (and larger than) the 25 MiB
// attachment cap, since build outputs run bigger than chat attachments. v1
// buffers the whole blob in memory before saving, which is fine for a local
// single-user server; a future streaming path would lift the ceiling.
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024

// An artifact name is addressable — it's a route segment and the download's
// Content-Disposition filename — so validate strictly: an alphanumeric or
// underscore lead (no leading dot), then dots/dashes/underscores/alphanumerics,
// capped at 128 chars, never a slash. Mirrors the closed-alphabet posture of the
// task and attachment ids.
const ARTIFACT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
export function isArtifactName(name: unknown): name is string {
  return typeof name === 'string' && ARTIFACT_NAME.test(name)
}

// Upsert a freshly published blob into a task's `artifacts` slot registry by
// name, returning the ref that now occupies the slot and the id of the blob it
// superseded (null on a first publish). Stays pure — no I/O: the caller deletes
// the superseded blob after the task write commits. On a republish the slot keeps
// its original `createdAt` and advances `updatedAt`; a new name is appended.
export function upsertArtifact(
  task: { artifacts?: Artifact[] },
  input: { name: string; blob: Attachment; at: string },
): { artifact: Artifact; supersededId: string | null } {
  const artifacts = (task.artifacts ??= [])
  const existing = artifacts.find((a) => a.name === input.name)
  const artifact: Artifact = {
    name: input.name,
    id: input.blob.id,
    mime: input.blob.mime,
    size: input.blob.size,
    createdAt: existing?.createdAt ?? input.at,
    updatedAt: input.at,
  }
  if (existing) {
    const supersededId = existing.id
    Object.assign(existing, artifact)
    return { artifact, supersededId }
  }
  artifacts.push(artifact)
  return { artifact, supersededId: null }
}
