import type { ToolItem } from './types'

// The before/after hunks of a file-writing tool call, rendered as a unified
// diff: the old text as removed (red) lines, the new text as added (green) ones.
// One block per edit (MultiEdit carries several); a Write has empty `old`, so it
// shows up as all additions.
function DiffView({ edits }: { edits: { old: string; new: string }[] }) {
  // Split into lines, dropping a single trailing empty line so a string ending
  // in "\n" doesn't render a spurious blank row. An empty side (e.g. a Write's
  // absent "before") contributes no lines at all.
  const lines = (s: string) => {
    if (s === '') return []
    const parts = s.split('\n')
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
    return parts
  }
  return (
    <div className="step-diff">
      {edits.map((e, k) => (
        <pre className="diff-hunk" key={k}>
          {lines(e.old).map((l, n) => (
            <div className="diff-line del" key={`o${n}`}>
              {'- ' + l}
            </div>
          ))}
          {lines(e.new).map((l, n) => (
            <div className="diff-line add" key={`n${n}`}>
              {'+ ' + l}
            </div>
          ))}
        </pre>
      ))}
    </div>
  )
}

// A disclosure: a triangle that rotates open, with revealable content dropping
// below behind a line down its left that marks the section's scope. The triangle
// either carries its own `label` (e.g. a turn's "12 STEPS…" summary) or sits
// beside an independently-clickable `summary` (e.g. a tool chip, which has its
// own click action). Both the tool detail and the turn fold render through this,
// so they share one look. `onToggle` gets the click event so a caller can read
// modifier keys.
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
      <div className="collapsible-row">
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
      </div>
      {open && children && (
        <div className="collapsible-body">{children}</div>
      )}
    </div>
  )
}

// A tool call in the activity trace: a chip (red when the call was blocked or
// failed) beside its one-line input. The tool item carries its own outcome
// (`status`) and captured output, folded in from the result — no use/result
// pairing anymore. When the chip has revealable detail — the full input, a
// file-writing tool's diff, any other tool's captured output, or a nested
// subagent trace — it becomes a disclosure: a triangle to its left and a
// clickable chip both toggle it (default closed), and option/shift-clicking
// toggles every such chip in the ride at once. A chip with no detail is a plain,
// non-interactive label. Grants moved to the per-turn blocked summary and the
// always-available control, so the chip no longer opens anything on its own.
export function ToolStep({
  item,
  detailOpen,
  onToggleDetail,
  subItems,
}: {
  item: ToolItem
  detailOpen: boolean
  // `all` is set when the user option/shift-clicked, asking to toggle every
  // detail in the ride rather than just this one.
  onToggleDetail: (all: boolean) => void
  // A subagent-spawning call (Agent/Explore) gets its subagent's whole activity
  // trace as its revealable detail, pre-rendered by the caller. Absent otherwise.
  subItems?: React.ReactNode
}) {
  // Whether the input alone makes the chip a disclosure: it does when the server
  // captured an untruncated copy, or when the raw input is multi-line — either way
  // there's more to see than the one-line chip shows. A plain single-line input
  // has nothing extra, so it stays a non-expanding label (older items predate
  // inputFull; a codex command is the multi-line case there).
  const hasInput = !!item.inputFull || item.input.includes('\n')
  // What the open body wraps: the server's untruncated capture, else the chip's
  // own input. It replaces the one-line copy on the chip once expanded.
  const fullInput = item.inputFull ?? item.input
  const hasDiff = !!item.edits && item.edits.length > 0
  // A subagent spawner reveals the nested trace; an edit reveals its diff;
  // everything else reveals its captured output (if any — a still-running call has
  // none yet). The trace subsumes the call's result text (it ends with the
  // subagent's final reply), and the diff wins over an Edit's noisy confirmation.
  // The full input, when present, rides above whichever of these the chip has.
  const hasChildren = !!subItems
  const hasResult = !hasDiff && !hasChildren && !!item.output
  const hasDetail = hasInput || hasDiff || hasChildren || hasResult
  const noun = hasDiff
    ? 'diff'
    : hasChildren
      ? 'activity'
      : hasResult
        ? 'output'
        : 'input'
  const errored = item.status === 'blocked' || item.status === 'failed'

  // The chip: a button that toggles the detail when there's detail to reveal (a
  // second hinge beside the triangle), else a plain label — never a dead button.
  const chip = (
    <>
      {hasDetail ? (
        <button
          type="button"
          className={'step-tool-name' + (errored ? ' errored' : '')}
          aria-expanded={detailOpen}
          onClick={(e) => onToggleDetail(e.altKey || e.shiftKey)}
        >
          {item.name}
        </button>
      ) : (
        <span className={'step-tool-name plain' + (errored ? ' errored' : '')}>
          {item.name}
        </span>
      )}
      {/* The one-line, ellipsized input rides the chip until the disclosure opens,
          when it moves into the body to wrap in full below. A plain chip has no
          body, so its input always stays here. */}
      {item.input && !(hasDetail && detailOpen) && (
        <span className="step-tool-input">{item.input}</span>
      )}
    </>
  )
  return (
    <div className="step-tool">
      {hasDetail ? (
        <Collapsible
          open={detailOpen}
          onToggle={(e) => onToggleDetail(e.altKey || e.shiftKey)}
          summary={chip}
          toggleLabel={`${detailOpen ? 'Hide' : 'Show'} ${noun}`}
          toggleTitle={`${detailOpen ? 'Hide' : 'Show'} ${noun} (⌥/⇧ for all)`}
        >
          {item.input && <div className="step-input">{fullInput}</div>}
          {hasDiff && <DiffView edits={item.edits!} />}
          {hasChildren && <div className="steps sub-steps">{subItems}</div>}
          {hasResult && (
            <div
              className={
                'step-result' + (errored ? ' errored' : '')
              }
            >
              {item.output}
            </div>
          )}
        </Collapsible>
      ) : (
        <div className="collapsible-row">{chip}</div>
      )}
    </div>
  )
}
