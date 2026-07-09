import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  saveAttachment,
  readAttachmentMeta,
  readAttachmentBytes,
  sanitizeName,
  isAttachmentId,
  AttachmentTooLargeError,
  MAX_ATTACHMENT_BYTES,
} from './attachments'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'lander-attach-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('saveAttachment', () => {
  it('persists a blob + metadata sidecar and returns the ref', async () => {
    const bytes = new TextEncoder().encode('a,b,c\n1,2,3\n')
    const meta = await saveAttachment(dir, {
      name: 'data.csv',
      mime: 'text/csv',
      bytes,
    })
    expect(meta).toMatchObject({
      name: 'data.csv',
      mime: 'text/csv',
      size: bytes.byteLength,
    })
    expect(isAttachmentId(meta.id)).toBe(true)

    // Blob is the raw bytes at <dir>/<id>; sidecar is the JSON meta.
    const blob = await readFile(path.join(dir, meta.id))
    expect(new Uint8Array(blob)).toEqual(bytes)
    const sidecar = JSON.parse(
      await readFile(path.join(dir, `${meta.id}.json`), 'utf8'),
    )
    expect(sidecar).toEqual(meta)
  })

  it('defaults a missing/blank mime to application/octet-stream', async () => {
    const meta = await saveAttachment(dir, {
      name: 'thing',
      mime: '',
      bytes: new Uint8Array([1, 2, 3]),
    })
    expect(meta.mime).toBe('application/octet-stream')
  })

  it('rejects an over-size upload', async () => {
    const bytes = new Uint8Array(MAX_ATTACHMENT_BYTES + 1)
    await expect(
      saveAttachment(dir, { name: 'big.bin', mime: 'application/octet-stream', bytes }),
    ).rejects.toBeInstanceOf(AttachmentTooLargeError)
  })
})

describe('readAttachmentMeta / readAttachmentBytes', () => {
  it('round-trips a saved attachment', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const meta = await saveAttachment(dir, { name: 'x.bin', mime: 'application/octet-stream', bytes })
    expect(await readAttachmentMeta(dir, meta.id)).toEqual(meta)
    expect(new Uint8Array((await readAttachmentBytes(dir, meta.id))!)).toEqual(bytes)
  })

  it('returns null for an unknown id', async () => {
    expect(await readAttachmentMeta(dir, 'does-not-exist')).toBeNull()
    expect(await readAttachmentBytes(dir, 'does-not-exist')).toBeNull()
  })

  it('returns null for a path-unsafe id rather than reading outside the dir', async () => {
    expect(isAttachmentId('../secret')).toBe(false)
    expect(await readAttachmentMeta(dir, '../secret')).toBeNull()
    expect(await readAttachmentBytes(dir, '../secret')).toBeNull()
  })
})

describe('sanitizeName', () => {
  it('drops directory components, keeping the basename', () => {
    expect(sanitizeName('/etc/passwd')).toBe('passwd')
    expect(sanitizeName('../../x.png')).toBe('x.png')
  })
  it('falls back to "file" for an empty/non-string name', () => {
    expect(sanitizeName('')).toBe('file')
    expect(sanitizeName(undefined)).toBe('file')
    expect(sanitizeName(42)).toBe('file')
  })
})
