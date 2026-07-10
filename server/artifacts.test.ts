import { describe, expect, it } from 'vitest'
import {
  isArtifactName,
  upsertArtifact,
  MAX_ARTIFACT_BYTES,
  type Artifact,
} from './artifacts'
import type { Attachment } from './attachments'

const blob = (over: Partial<Attachment> = {}): Attachment => ({
  id: 'blob-1',
  name: 'out.txt',
  mime: 'text/plain',
  size: 12,
  ...over,
})

describe('isArtifactName', () => {
  it('accepts alphanumerics, dots, dashes and underscores', () => {
    expect(isArtifactName('report.pdf')).toBe(true)
    expect(isArtifactName('build-1.2_final.tar.gz')).toBe(true)
    expect(isArtifactName('_hidden')).toBe(true)
    expect(isArtifactName('a')).toBe(true)
    expect(isArtifactName('A'.repeat(128))).toBe(true)
  })
  it('rejects a leading dot, slashes, spaces and over-long names', () => {
    expect(isArtifactName('.env')).toBe(false)
    expect(isArtifactName('dir/file')).toBe(false)
    expect(isArtifactName('../escape')).toBe(false)
    expect(isArtifactName('has space')).toBe(false)
    expect(isArtifactName('')).toBe(false)
    expect(isArtifactName('A'.repeat(129))).toBe(false)
    expect(isArtifactName(42)).toBe(false)
    expect(isArtifactName(undefined)).toBe(false)
  })
})

describe('MAX_ARTIFACT_BYTES', () => {
  it('is 100 MiB, larger than the attachment cap', () => {
    expect(MAX_ARTIFACT_BYTES).toBe(100 * 1024 * 1024)
  })
})

describe('upsertArtifact', () => {
  it('appends a new slot on first publish and reports no superseded blob', () => {
    const task: { artifacts?: Artifact[] } = {}
    const { artifact, supersededId } = upsertArtifact(task, {
      name: 'out.txt',
      blob: blob(),
      at: '2026-01-01T00:00:00.000Z',
    })
    expect(supersededId).toBeNull()
    expect(artifact).toEqual({
      name: 'out.txt',
      id: 'blob-1',
      mime: 'text/plain',
      size: 12,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(task.artifacts).toEqual([artifact])
  })

  it('republishing a name keeps createdAt, advances updatedAt, returns the old blob id', () => {
    const task: { artifacts?: Artifact[] } = {}
    upsertArtifact(task, {
      name: 'out.txt',
      blob: blob({ id: 'blob-1', size: 12 }),
      at: '2026-01-01T00:00:00.000Z',
    })
    const { artifact, supersededId } = upsertArtifact(task, {
      name: 'out.txt',
      blob: blob({ id: 'blob-2', size: 99, mime: 'text/csv' }),
      at: '2026-01-02T00:00:00.000Z',
    })
    expect(supersededId).toBe('blob-1')
    expect(task.artifacts).toHaveLength(1)
    expect(artifact).toMatchObject({
      name: 'out.txt',
      id: 'blob-2',
      mime: 'text/csv',
      size: 99,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    })
  })

  it('keeps distinct names as separate slots', () => {
    const task: { artifacts?: Artifact[] } = {}
    upsertArtifact(task, { name: 'a.txt', blob: blob({ id: 'b1' }), at: 'T1' })
    upsertArtifact(task, { name: 'b.txt', blob: blob({ id: 'b2' }), at: 'T2' })
    expect(task.artifacts?.map((a) => a.name)).toEqual(['a.txt', 'b.txt'])
  })
})
