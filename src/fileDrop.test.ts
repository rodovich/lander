import { describe, expect, it } from 'vitest'
import { dataTransferHasFiles } from './fileDrop'

function transfer({
  files = 0,
  items = [],
  types = [],
}: {
  files?: number
  items?: { kind: string }[]
  types?: string[]
}): Pick<DataTransfer, 'files' | 'items' | 'types'> {
  return { files: { length: files }, items, types } as unknown as Pick<
    DataTransfer,
    'files' | 'items' | 'types'
  >
}

describe('dataTransferHasFiles', () => {
  it('recognizes Chromium file items even when no Files type is exposed', () => {
    expect(dataTransferHasFiles(transfer({ items: [{ kind: 'file' }] }))).toBe(
      true,
    )
  })

  it('recognizes the conventional Files drag type', () => {
    expect(dataTransferHasFiles(transfer({ types: ['Files'] }))).toBe(true)
  })

  it('recognizes a populated file list on drop', () => {
    expect(dataTransferHasFiles(transfer({ files: 1 }))).toBe(true)
  })

  it('does not intercept ordinary dragged text', () => {
    expect(
      dataTransferHasFiles(
        transfer({ items: [{ kind: 'string' }], types: ['text/plain'] }),
      ),
    ).toBe(false)
  })
})
