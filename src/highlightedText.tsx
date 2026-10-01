// Text with every case-insensitive occurrence of `query` marked. `query` is
// already lowercased. When lowercasing changes the text's length (a few
// non-ASCII letters do), offsets into the lowercased copy no longer line up
// with the text, so it renders unmarked rather than marking the wrong span.
export function HighlightedText({ text, query }: { text: string; query: string }) {
  const lower = text.toLowerCase()
  if (!query || lower.length !== text.length) return <>{text}</>
  const pieces: React.ReactNode[] = []
  let from = 0
  for (let i = lower.indexOf(query); i !== -1; i = lower.indexOf(query, from)) {
    if (i > from) pieces.push(text.slice(from, i))
    from = i + query.length
    pieces.push(
      <mark key={i} className="text-highlight">
        {text.slice(i, from)}
      </mark>,
    )
  }
  if (from < text.length) pieces.push(text.slice(from))
  return <>{pieces}</>
}
