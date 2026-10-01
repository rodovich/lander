// Every case-insensitive occurrence of `query` (already lowercased) in the text
// under `root`, as DOM ranges. An occurrence split across elements — part of
// it bold, say — isn't found: each text node is searched on its own.
export function findTextRanges(root: Node, query: string): Range[] {
  const ranges: Range[] = []
  if (!query) return ranges
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? ''
    const lower = text.toLowerCase()
    // Offsets into the lowercased copy only hold while it's the same length.
    if (lower.length !== text.length) continue
    for (
      let i = lower.indexOf(query);
      i !== -1;
      i = lower.indexOf(query, i + query.length)
    ) {
      const range = document.createRange()
      range.setStart(node, i)
      range.setEnd(node, i + query.length)
      ranges.push(range)
    }
  }
  return ranges
}

// Paints `ranges` with the `::highlight(name)` rule, without touching the DOM
// they're in. Returns the undo. A no-op where the browser lacks the CSS Custom
// Highlight API.
export function paintRanges(name: string, ranges: Range[]): () => void {
  if (typeof CSS === 'undefined' || !CSS.highlights) return () => {}
  const highlight = new Highlight(...ranges)
  CSS.highlights.set(name, highlight)
  return () => {
    if (CSS.highlights.get(name) === highlight) CSS.highlights.delete(name)
  }
}
