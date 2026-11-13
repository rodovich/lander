export function shouldAttachPastedText(text: string): boolean {
  return text.length >= 1000 || text.split(/\r\n|\r|\n/).length >= 12
}

// A marker names its file, so no two files in a draft may share a name — and
// browsers name every pasted screenshot `image.png`.
export function uniquelyNamedFiles(attached: readonly { name: string }[], picked: File[]): File[] {
  const taken = new Set(attached.map((file) => file.name))
  return picked.map((file) => {
    let name = file.name
    if (taken.has(name)) {
      const dot = name.lastIndexOf('.')
      const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
      let number = 2
      while (taken.has(`${stem}-${number}${extension}`)) number++
      name = `${stem}-${number}${extension}`
    }
    taken.add(name)
    return name === file.name
      ? file
      : new File([file], name, { type: file.type, lastModified: file.lastModified })
  })
}

function attachmentMarker(file: { name: string }): string {
  return `[${file.name}]`
}

export function insertAttachmentMarkers(
  value: string,
  start: number,
  end: number,
  files: readonly { name: string }[],
): { text: string; caret: number } {
  const markers = files.map(attachmentMarker).join(' ')
  const before = value.slice(0, start)
  const after = value.slice(end)
  const insertion =
    (before && !/\s$/.test(before) ? ' ' : '') +
    markers +
    (after && !/^\s/.test(after) ? ' ' : '')
  return { text: before + insertion + after, caret: before.length + insertion.length }
}

export function removeAttachmentMarkers(value: string, files: readonly { name: string }[]): string {
  return files.reduce((text, file) => text.replaceAll(attachmentMarker(file), ''), value)
}
