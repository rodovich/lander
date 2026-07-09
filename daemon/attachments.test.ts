import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  materializeAttachments,
  buildManifestBlock,
  taskFilesDir,
  isImage,
} from './attachments'
import type { AttachmentRef } from '../server/protocol'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lander-daemon-attach-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: 'id1',
  name: 'data.csv',
  mime: 'text/csv',
  size: 3,
  ...over,
})

describe('materializeAttachments', () => {
  it('fetches missing blobs, writes them, and returns image paths + block', async () => {
    const fetchBytes = vi.fn(async (r: AttachmentRef) =>
      new TextEncoder().encode(`bytes-of-${r.id}`),
    )
    const out = await materializeAttachments({
      filesDir: dir,
      attachments: [ref(), ref({ id: 'img1', name: 'p.png', mime: 'image/png' })],
      fetchBytes,
      visionNative: true,
    })
    expect(fetchBytes).toHaveBeenCalledTimes(2)
    // Blobs written at <dir>/<id>.
    expect(await readFile(path.join(dir, 'id1'), 'utf8')).toBe('bytes-of-id1')
    expect(await readFile(path.join(dir, 'img1'), 'utf8')).toBe('bytes-of-img1')
    // Only images surface for the vision channel.
    expect(out.images).toEqual([path.join(dir, 'img1')])
    expect(out.filesDir).toBe(dir)
    expect(out.manifestBlock).toContain('data.csv')
  })

  it('does not re-fetch a blob already on disk (cached across turns)', async () => {
    await writeFile(path.join(dir, 'id1'), 'already-here')
    const fetchBytes = vi.fn(async () => new Uint8Array([0]))
    await materializeAttachments({
      filesDir: dir,
      attachments: [ref()],
      fetchBytes,
      visionNative: false,
    })
    expect(fetchBytes).not.toHaveBeenCalled()
    expect(await readFile(path.join(dir, 'id1'), 'utf8')).toBe('already-here')
  })

  it('unions manifest.json across turns, keyed by id', async () => {
    const fetchBytes = async () => new Uint8Array([1])
    await materializeAttachments({
      filesDir: dir,
      attachments: [ref({ id: 'a' })],
      fetchBytes,
      visionNative: false,
    })
    await materializeAttachments({
      filesDir: dir,
      attachments: [ref({ id: 'b', name: 'b.txt', mime: 'text/plain' })],
      fetchBytes,
      visionNative: false,
    })
    const manifest = JSON.parse(
      await readFile(path.join(dir, 'manifest.json'), 'utf8'),
    ) as AttachmentRef[]
    expect(manifest.map((m) => m.id).sort()).toEqual(['a', 'b'])
  })
})

describe('buildManifestBlock', () => {
  it('is empty when there are no attachments', () => {
    expect(buildManifestBlock(dir, [], true)).toBe('')
  })

  it('tells a vision-native agent images are already attached', () => {
    const block = buildManifestBlock(
      dir,
      [ref({ id: 'img', name: 'p.png', mime: 'image/png' })],
      true,
    )
    expect(block).toContain('already attached to your vision')
    expect(block).toContain('lander file cat')
  })

  it('gives a non-vision agent the image path to Read', () => {
    const block = buildManifestBlock(
      dir,
      [ref({ id: 'img', name: 'p.png', mime: 'image/png' })],
      false,
    )
    expect(block).toContain('Read tool')
    expect(block).toContain(path.join(dir, 'img'))
  })
})

describe('helpers', () => {
  it('taskFilesDir keys by project + task', () => {
    expect(taskFilesDir('/root', 'proj', 't1')).toBe(
      path.join('/root', 'proj', 't1'),
    )
  })
  it('isImage matches image/* mimes only', () => {
    expect(isImage('image/png')).toBe(true)
    expect(isImage('text/csv')).toBe(false)
  })
})
