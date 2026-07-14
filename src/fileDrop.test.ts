import { describe, expect, it } from 'vitest'
import { clipboardImageFiles, dataTransferHasFiles } from './fileDrop'

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

function pngFile(name = 'image.png'): File {
  return { name, type: 'image/png' } as unknown as File
}

function clipboard({
  items = [],
  files = [],
}: {
  items?: { kind: string; type: string; getAsFile: () => File | null }[]
  files?: File[]
}): Pick<DataTransfer, 'items' | 'files'> {
  return { items, files } as unknown as Pick<DataTransfer, 'items' | 'files'>
}

describe('clipboardImageFiles', () => {
  it('extracts a pasted image from clipboard items', () => {
    const file = pngFile()
    const files = clipboardImageFiles(
      clipboard({
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
      }),
    )
    expect(files).toEqual([file])
  })

  it('ignores non-image and non-file clipboard items', () => {
    expect(
      clipboardImageFiles(
        clipboard({
          items: [
            { kind: 'string', type: 'text/plain', getAsFile: () => null },
            { kind: 'file', type: 'application/pdf', getAsFile: () => pngFile('doc.pdf') },
          ],
        }),
      ),
    ).toEqual([])
  })

  it('falls back to the file list when items are empty', () => {
    const file = pngFile()
    expect(
      clipboardImageFiles(clipboard({ files: [file, { name: 't.txt', type: 'text/plain' } as unknown as File] })),
    ).toEqual([file])
  })

  it('yields nothing for a plain text paste', () => {
    expect(clipboardImageFiles(clipboard({}))).toEqual([])
  })
})
