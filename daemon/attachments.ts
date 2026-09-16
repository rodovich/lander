// Daemon-side attachment materialization. At turn time the daemon fetches a run's
// attachment bytes from the server's authed download endpoint into a stable
// per-task dir (LANDER_FILES_DIR, cached across turns so `lander attachment cat` keeps
// working), refreshes that dir's manifest.json, and builds the prompt-facing
// manifest block. Images additionally surface their local path for the vision
// channel (Codex --image / Claude Read). Pure of the run manager's wiring so the
// fetch is injectable for tests.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { AttachmentRef } from '../server/protocol'

// Where a task's materialized blobs live on the daemon host. Cached across turns
// (never cleaned per-run) so repeat `lander attachment cat` reads stay local and cheap.
// Under the OS temp dir by default; keyed by project slug + task id.
export function defaultFilesRoot(): string {
  return path.join(os.tmpdir(), 'lander-files')
}
export function taskFilesDir(
  root: string,
  project: string,
  taskId: string,
): string {
  return path.join(root, project, taskId)
}

export function isImage(mime: string): boolean {
  return mime.startsWith('image/')
}

// `run` is absent on rows written before it was recorded; `ls` renders those as
// an unknown turn rather than guessing one.
export type ManifestEntry = AttachmentRef & { run?: string }

export type MaterializedFiles = {
  // The per-task dir, injected to the child as LANDER_FILES_DIR.
  filesDir: string
  // Absolute paths of this turn's image blobs, for the flow's vision channel.
  images: string[]
  // The prompt-facing manifest block to append to the outgoing message.
  manifestBlock: string
}

type FetchBytes = (ref: AttachmentRef) => Promise<Uint8Array>

// Fetch and cache this turn's attachment blobs, refresh manifest.json (the union
// of every attachment the task has ever carried, so `lander attachment ls`/`cat` see
// them all), and build the prompt block. A blob already on disk isn't re-fetched.
export async function materializeAttachments(opts: {
  filesDir: string
  attachments: AttachmentRef[]
  fetchBytes: FetchBytes
  // Whether the provider delivers images to vision itself (Codex) — the block's
  // image instructions differ when the agent must Read the path instead (Claude).
  visionNative: boolean
  // The run these attachments arrive on, stamped onto their manifest rows.
  run?: string
  fileExists?: (p: string) => Promise<boolean>
}): Promise<MaterializedFiles> {
  const { filesDir, attachments, fetchBytes, visionNative } = opts
  const exists = opts.fileExists ?? defaultFileExists
  await mkdir(filesDir, { recursive: true })

  for (const ref of attachments) {
    const dest = path.join(filesDir, ref.id)
    if (await exists(dest)) continue
    const bytes = await fetchBytes(ref)
    await writeFile(dest, bytes)
  }

  await refreshManifest(filesDir, attachments, opts.run)

  const images = attachments
    .filter((a) => isImage(a.mime))
    .map((a) => path.join(filesDir, a.id))
  const manifestBlock = buildManifestBlock(filesDir, attachments, visionNative)
  return { filesDir, images, manifestBlock }
}

// The on-disk manifest.json `lander attachment ls` reads, unioned by id with
// whatever prior turns left, so a file attached earlier stays listable on a turn
// that attaches nothing. An entry already present keeps its original run: it
// belongs to the turn it arrived on, not to whichever turn last rewrote the file.
async function refreshManifest(
  filesDir: string,
  attachments: AttachmentRef[],
  run?: string,
): Promise<void> {
  const file = path.join(filesDir, 'manifest.json')
  let existing: ManifestEntry[] = []
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (Array.isArray(parsed)) existing = parsed as ManifestEntry[]
  } catch {
    // no manifest yet, or unreadable — start fresh
  }
  const byId = new Map<string, ManifestEntry>()
  for (const a of existing) if (a && typeof a.id === 'string') byId.set(a.id, a)
  for (const a of attachments)
    byId.set(a.id, {
      id: a.id,
      name: a.name,
      mime: a.mime,
      size: a.size,
      ...(byId.get(a.id)?.run ? { run: byId.get(a.id)!.run } : run ? { run } : {}),
    })
  await writeFile(file, JSON.stringify([...byId.values()], null, 2))
}

// Build the block appended to the outgoing prompt (like buildTurnContext): a
// manifest of this turn's attachments plus how to reach them. The bytes never go
// in the prompt — only this listing and the instructions.
export function buildManifestBlock(
  filesDir: string,
  attachments: AttachmentRef[],
  visionNative: boolean,
): string {
  if (!attachments.length) return ''
  const lines: string[] = [
    '<task-attachments>',
    'Files attached to this message by the user (materialized locally, not shown ' +
      'in the text above):',
    '',
  ]
  for (const a of attachments)
    lines.push(
      `- ${a.name} (id: ${a.id}, ${a.mime}, ${a.size} bytes)` +
        (isImage(a.mime) ? ' [image]' : ''),
    )
  const images = attachments.filter((a) => isImage(a.mime))
  if (images.length) {
    lines.push('')
    if (visionNative) {
      lines.push('The image(s) above are already attached to your vision.')
    } else {
      lines.push(
        'To view an image, use the Read tool on its local path:',
      )
      for (const a of images)
        lines.push(`- ${a.name}: ${path.join(filesDir, a.id)}`)
    }
  }
  lines.push(
    '',
    'To read any attached file’s raw bytes, run `lander attachment cat <id>` ' +
      '(list them with `lander attachment ls`). To show the user a file you ' +
      'produce, run `lander attachment put <path>` — it appears on your reply.',
    '</task-attachments>',
  )
  return lines.join('\n')
}

async function defaultFileExists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
