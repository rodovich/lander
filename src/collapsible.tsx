// A disclosure: a triangle that rotates open, with revealable content dropping
// below behind a line down its left that marks the section's scope. The triangle
// either carries its own `label` (e.g. a turn's "12 STEPS…" summary) or sits
// beside an independently-clickable `summary` (e.g. a tool chip, which has its
// own click action). The tool detail, the turn fold, and the timeline note all
// render through this, so they share one look. `onToggle` gets the click event
// so a caller can read modifier keys.
export function Collapsible({
  open,
  onToggle,
  label,
  summary,
  toggleTitle,
  toggleLabel,
  children,
}: {
  open: boolean
  onToggle: (e: React.MouseEvent) => void
  label?: React.ReactNode
  summary?: React.ReactNode
  toggleTitle?: string
  toggleLabel?: string
  children?: React.ReactNode
}) {
  return (
    <div className="collapsible">
      <CollapsibleRow>
        <button
          type="button"
          className="collapsible-toggle"
          aria-expanded={open}
          aria-label={toggleLabel}
          title={toggleTitle}
          onClick={onToggle}
        >
          <span className={'step-diff-caret' + (open ? ' open' : '')}>▶</span>
          {label}
        </button>
        {summary}
      </CollapsibleRow>
      {open && children && <div className="collapsible-body">{children}</div>}
    </div>
  )
}

// The row a disclosure's summary sits on, on its own: what a chip or a note
// with nothing to reveal wears, so it keeps the same geometry as one that has
// something to reveal.
export function CollapsibleRow({ children }: { children: React.ReactNode }) {
  return <div className="collapsible-row">{children}</div>
}
