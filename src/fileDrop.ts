// Browsers do not expose file drags uniformly before the drop. Chromium makes
// the item kind available, while other engines may expose only the conventional
// "Files" type. Check both so dragover can always be cancelled before the
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
