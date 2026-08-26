import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useAnchoredPopup } from './hooks'
import type { BlockedRequest } from './permissions'
import type { Task } from './types'

// The no-smoking-style prohibition mark — a circle with a diagonal slash, no
// cigarette — that leads the "N permissions blocked this turn" summary.
function BlockedIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="5.64" y1="5.64" x2="18.36" y2="18.36" />
    </svg>
  )
}

// One editable permission rule with a kebab of grant scopes. Shared by the
// per-turn blocked-permissions popup (each row seeded from a denied call) and the
// always-available grant control (a single empty row authored from scratch). The
// rule string is click-to-edit like the task title — click swaps in an input
// seeded with the current rule; Enter/blur commits, Escape reverts — and the
// committed draft is exactly what the kebab actions grant, so the user can shape
// the rule (`git log` → `git:*`) before allowing it. Menu-open state is lifted to
// the parent so only one row's kebab is open at a time. Rule strings stay opaque
// agent-owned data: which scopes a grant is honored in comes from the task's
// server-derived `grants` capability flags — when task-scope isn't honored (codex
// today) "allow in task" reads "save rule" and carries a parity note, and when
// project scope isn't supported that action is disabled.
export function RuleRow({
  rule: initialRule,
  grants,
  menuOpen,
  onToggleMenu,
  onAllow,
  granted,
  onGranted,
  autoEdit,
  placeholder,
}: {
  rule: string
  grants: Task['grants']
  menuOpen: boolean
  onToggleMenu: () => void
  onAllow: (rule: string, scope: 'task' | 'project') => Promise<boolean>
  // The scope this rule was granted in, if any — owned by the parent so it
  // survives the popup closing and reopening; null shows the kebab, a value the
  // checkmark. `onGranted` records a successful grant.
  granted: 'task' | 'project' | null
  onGranted: (scope: 'task' | 'project') => void
  // Start in edit mode (the empty authoring row); a seeded denial row starts read.
  autoEdit?: boolean
  placeholder?: string
}) {
  const [editing, setEditing] = useState(!!autoEdit)
  const [committed, setCommitted] = useState(initialRule)
  const [draft, setDraft] = useState(initialRule)
  const inputRef = useRef<HTMLInputElement>(null)
  const kebabRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // Open the scope menu upward when there isn't room for it below the kebab, so
  // it can't spill past the window's bottom (measured against the kebab's live
  // viewport rect, so it works wherever the enclosing popup ended up).
  const [menuUp, setMenuUp] = useState(false)
  // Absent capabilities (legacy payloads) default to fully capable.
  const canGrantTask = grants?.task ?? true
  const canGrantProject = grants?.project ?? true

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuUp(false)
      return
    }
    const kr = kebabRef.current?.getBoundingClientRect()
    const mh = menuRef.current?.offsetHeight ?? 0
    if (kr) {
      const spaceBelow = window.innerHeight - kr.bottom
      setMenuUp(mh > 0 && spaceBelow < mh + 8 && kr.top > spaceBelow)
    }
  }, [menuOpen])

  function commit() {
    setCommitted(draft.trim())
    setEditing(false)
  }
  function cancel() {
    setDraft(committed)
    setEditing(false)
  }
  async function grant(scope: 'task' | 'project') {
    onToggleMenu() // close this row's menu (it is the open one)
    if (await onAllow(committed, scope)) onGranted(scope)
  }

  return (
    <div className="rule-row">
      {granted ? (
        // Once granted, the row records what was allowed — editing the text
        // would misrepresent the rule the grant actually covers.
        <span className="rule-row-rule readonly">{committed}</span>
      ) : editing ? (
        <input
          ref={inputRef}
          className="rule-row-input"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
          onBlur={commit}
        />
      ) : (
        <button
          type="button"
          className="rule-row-rule"
          title="Click to edit"
          onClick={() => {
            setDraft(committed)
            setEditing(true)
          }}
        >
          {committed || (
            <span className="rule-row-placeholder">
              {placeholder ?? 'Add a rule…'}
            </span>
          )}
        </button>
      )}
      {granted ? (
        <span
          className="rule-row-granted"
          title={
            (granted === 'project' ? canGrantProject : canGrantTask)
              ? `Allowed in ${granted}`
              : 'Rule saved'
          }
        >
          ✓
        </span>
      ) : (
        <div className="rule-row-menu">
          <button
            ref={kebabRef}
            type="button"
            className="rule-row-kebab"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Grant scope"
            disabled={!committed}
            onClick={onToggleMenu}
          >
            ⋮
          </button>
          {menuOpen && (
            <div
              ref={menuRef}
              className={'rule-row-menu-popup' + (menuUp ? ' up' : '')}
              role="menu"
            >
              <button
                type="button"
                role="menuitem"
                className="task-menu-item"
                title={
                  canGrantTask
                    ? undefined
                    : "Saved for parity; this task's agent does not honor task allow rules yet"
                }
                onClick={() => void grant('task')}
              >
                {canGrantTask ? 'Allow in task' : 'Save rule'}
              </button>
              <button
                type="button"
                role="menuitem"
                className="task-menu-item"
                disabled={!canGrantProject}
                title={
                  canGrantProject
                    ? undefined
                    : "Project grants are not supported for this task's agent yet"
                }
                onClick={() => void grant('project')}
              >
                {canGrantProject ? 'Allow in project' : 'Project unsupported'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// The per-turn denial-review surface at the foot of a finished assistant message:
// a muted "N permissions blocked this turn" line that opens a fixed-anchored
// popup of editable rule rows (one per deduped denial), each grantable in task or
// project scope. Fixed-positioned like the other header/chip popups so the
// scrolling timeline can't clip it. Only rendered when there are confirmed
// denials, so a task whose agent never reports them (codex) simply shows nothing.
export function BlockedSummary({
  requests,
  grants,
  onAllow,
}: {
  requests: BlockedRequest[]
  grants: Task['grants']
  onAllow: (rule: string, scope: 'task' | 'project') => Promise<boolean>
}) {
  const { open, setOpen, containerRef, triggerRef, popupRef, popupStyle } =
    useAnchoredPopup()
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null)
  // Which rules have been granted, kept here (not in the rows) so a checkmark
  // survives the popup closing and reopening within this turn's summary.
  const [granted, setGranted] = useState<Record<string, 'task' | 'project'>>({})

  useEffect(() => {
    if (!open) setOpenMenuKey(null)
  }, [open])

  return (
    <div className="blocked-summary" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="blocked-summary-line"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <BlockedIcon />
        {requests.length} permission{requests.length === 1 ? '' : 's'} blocked
        this turn
      </button>
      {open && (
        <div ref={popupRef} className="blocked-popup" style={popupStyle}>
          {requests.map((r) => (
            <RuleRow
              key={r.key}
              rule={r.rule}
              grants={grants}
              menuOpen={openMenuKey === r.key}
              onToggleMenu={() =>
                setOpenMenuKey((k) => (k === r.key ? null : r.key))
              }
              onAllow={onAllow}
              granted={granted[r.key] ?? null}
              onGranted={(scope) =>
                setGranted((g) => ({ ...g, [r.key]: scope }))
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

// The rubber-stamp mark on the always-available grant control — authoring a rule
// is "stamping" an approval. A handled stamp pressing down onto its base plate.
function StampIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 5a3 3 0 0 1 6 0c0 1.6-1.2 2.1-1.2 3.4 0 1 .8 1.3 1.7 2 .9.8 1 1.6 1 3.1H6.5c0-1.5.1-2.3 1-3.1.9-.7 1.7-1 1.7-2C10.2 7.1 9 6.6 9 5z" />
      <line x1="4.5" y1="17" x2="19.5" y2="17" />
      <line x1="6.5" y1="20.5" x2="17.5" y2="20.5" />
    </svg>
  )
}

// The rules already on the task (`task.allow`), listed above the authoring row so
// the popup answers "what does this task already have?" before it offers to widen
// it. Read-only: a rule's text is the grant, so editing it here would misrepresent
// what the agent actually runs under — revoking isn't a surface yet. Project-scope
// grants live in the project's settings file, outside any one task, so they aren't
// listed. When the flow doesn't honor task rules (codex) these were saved for
// parity only, and the label says so rather than claiming they are in force.
export function GrantedRules({
  rules,
  honored,
}: {
  rules: string[]
  honored: boolean
}) {
  if (rules.length === 0) return null
  return (
    <>
      <div className="rule-popup-head">
        {honored ? 'Allowed in this task' : 'Saved on this task (not honored)'}
      </div>
      {rules.map((rule) => (
        <div className="rule-row" key={rule}>
          <span className="rule-row-rule readonly">{rule}</span>
        </div>
      ))}
    </>
  )
}

// The always-available grant control in the task header: a rubber-stamp button
// that opens the task's permission popup — the rules already granted on the task,
// above a one-row rule-authoring row (the same RuleRow the blocked summary uses,
// empty, with the same task/project kebab) — so a rule can be granted proactively,
// no archaeology through denied chips. The doc's primary permission surface;
// permission asks will later deep-link into it with a prefill. Fixed-anchored like
// the other header popups so it can't be clipped.
export function GrantControl({
  grants,
  allow,
  onAllow,
}: {
  grants: Task['grants']
  // The task's own granted rules, listed above the authoring row. Absent on a
  // task that has never been granted one (and on a pre-`allow` payload).
  allow: Task['allow']
  onAllow: (rule: string, scope: 'task' | 'project') => Promise<boolean>
}) {
  const { open, setOpen, containerRef, triggerRef, popupRef, popupStyle } =
    useAnchoredPopup()
  const [menuOpen, setMenuOpen] = useState(false)
  const [granted, setGranted] = useState<'task' | 'project' | null>(null)

  // Each open starts a fresh authoring row (empty rule, no checkmark).
  useEffect(() => {
    if (!open) {
      setMenuOpen(false)
      setGranted(null)
    }
  }, [open])

  return (
    <div className="task-menu" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="edit-title-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Permissions"
        aria-label="Permissions"
        onClick={() => setOpen((o) => !o)}
      >
        <StampIcon />
      </button>
      {open && (
        <div ref={popupRef} className="blocked-popup" style={popupStyle}>
          <GrantedRules rules={allow ?? []} honored={grants?.task ?? true} />
          <div className={'rule-popup-head' + (allow?.length ? ' divided' : '')}>
            Grant a permission rule
          </div>
          {/* One empty row, remounted fresh each time the popup reopens (the
              popup unmounts on close), so authoring another rule is one reopen. */}
          <RuleRow
            rule=""
            grants={grants}
            autoEdit
            placeholder="e.g. Bash(git:*)"
            menuOpen={menuOpen}
            onToggleMenu={() => setMenuOpen((o) => !o)}
            onAllow={onAllow}
            granted={granted}
            onGranted={(scope) => setGranted(scope)}
          />
        </div>
      )}
    </div>
  )
}
