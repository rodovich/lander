export function shouldAttachPastedText(text: string): boolean {
  return text.length >= 1000 || text.split(/\r\n|\r|\n/).length >= 12
}

export function insertAttachmentMarkers(
  value: string,
  start: number,
  end: number,
  existingFiles: number,
  addedFiles: number,
): { text: string; caret: number } {
  const markers = Array.from({ length: addedFiles }, (_, index) => {
    const number = existingFiles + index + 1
    return number === 1 ? '[Attachment]' : `[Attachment ${number}]`
  }).join(' ')
  const before = value.slice(0, start)
  const after = value.slice(end)
  const insertion =
    (before && !/\s$/.test(before) ? ' ' : '') +
    markers +
    (after && !/^\s/.test(after) ? ' ' : '')
  return { text: before + insertion + after, caret: before.length + insertion.length }
}

export function removeAttachmentMarkers(value: string, files: number): string {
  return value.replace(/\[Attachment(?: (\d+))?\]/g, (marker, number: string | undefined) =>
    Number(number ?? 1) <= files ? '' : marker,
  )
}
