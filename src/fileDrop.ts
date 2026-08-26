// Browsers do not expose file drags uniformly before the drop. Chromium makes
// the item kind available, while other engines may expose only the conventional
// "Files" type. Check both so dragover can always be canceled before the
// browser falls back to navigating to the local file.
export function dataTransferHasFiles(
  transfer: Pick<DataTransfer, 'files' | 'items' | 'types'>,
): boolean {
  // `files` is generally protected/empty during dragover but populated for the
  // drop itself, making it the definitive last check before default navigation.
  if (transfer.files.length > 0) return true
  if (Array.from(transfer.items).some((item) => item.kind === 'file')) return true
  return Array.from(transfer.types).some(
    (type) => type.toLowerCase() === 'files',
  )
}

// Pull pasted image files out of a clipboard payload. A screenshot or copied
// image arrives as a file entry (kind 'file') whose type begins with 'image/';
// plain or rich text carries no such entry, so an ordinary text paste yields an
// empty list and is left to the textarea's default handling. Like
// dataTransferHasFiles this reads both `items` and `files`, since engines
// populate them unevenly — items exposes the type for filtering, while `files`
// is the reliable fallback when items is empty.
export function clipboardImageFiles(
  clipboard: Pick<DataTransfer, 'items' | 'files'>,
): File[] {
  const fromItems = Array.from(clipboard.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file != null)
  if (fromItems.length > 0) return fromItems
  return Array.from(clipboard.files).filter((file) =>
    file.type.startsWith('image/'),
  )
}
