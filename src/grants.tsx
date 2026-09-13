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

type GrantScope = 'task' | 'project'

// What a row was granted as: the scope, and the rule text as it stood when
// granted — which may differ from the rule the row was seeded with.
export type Granted = { scope: GrantScope; rule: string }

// One editable permission rule with a kebab of grant scopes, drawn by RulePopup.
// The rule string is click-to-edit like the task title — click swaps in an input
// seeded with the current rule; Enter/blur commits, Escape reverts — and the
// committed draft is exactly what the kebab actions grant, so the user can shape
// the rule (`git log` → `git:*`) before allowing it. Which row's kebab is open,
// and what has been granted, belong to the popup. Rule strings stay opaque
// agent-owned data: which scopes a grant is honored in comes from the task's
// server-derived `grants` capability flags — when task-scope isn't honored (codex
// today) "allow in task" reads "save rule" and carries a parity note, and when
// project scope isn't supported that action is disabled.
export function RuleRow({
  rule: initialRule,
  grants,
  menuOpen,
  onToggleMenu,
  granted,
  onGrant,
  autoEdit,
  placeholder,
}: {
  rule: string
  grants: Task['grants']
  menuOpen: boolean
  onToggleMenu: () => void
  // Null shows the kebab; a grant shows the checkmark and the rule it covered.
  granted: Granted | null
  onGrant: (rule: string, scope: GrantScope) => void
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

  return (
    <div className="rule-row">
      {granted ? (
        // Once granted, the row records what was allowed — editing the text
        // would misrepresent the rule the grant actually covers.
        <span className="rule-row-rule readonly">{granted.rule}</span>
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
            (granted.scope === 'project' ? canGrantProject : canGrantTask)
              ? `Allowed in ${granted.scope}`
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
                className="rule-row-menu-item"
                title={
                  canGrantTask
                    ? undefined
                    : "Saved for parity; this task's agent does not honor task allow rules yet"
                }
                onClick={() => onGrant(committed, 'task')}
              >
                {canGrantTask ? 'Allow in task' : 'Save rule'}
              </button>
              <button
                type="button"
                role="menuitem"
                className="rule-row-menu-item"
                disabled={!canGrantProject}
                title={
                  canGrantProject
                    ? undefined
                    : "Project grants are not supported for this task's agent yet"
                }
                onClick={() => onGrant(committed, 'project')}
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

// The key the authoring row goes by among the seeded ones.
const AUTHORING_KEY = '\0new'

// A trigger that opens a fixed-anchored popup of rule rows, each grantable in
// task or project scope. Fixed-positioned like the other header/chip popups so
// neither the scrolling timeline nor the header can clip it. Owns the rows'
// shared bookkeeping: at most one row's kebab open at a time, and what each row
// has been granted. The grants live here, above the popup, so a checkmark can
// outlive the popup closing — unless `forgetOnClose`, for a popup whose every
// open should start fresh.
function RulePopup({
  className,
  trigger,
  head,
  rules,
  authoring,
  forgetOnClose,
  grants,
  onAllow,
}: {
  className: string
  trigger: { className: string; label?: string; content: React.ReactNode }
  // Above the rows.
  head?: React.ReactNode
  // Seeded rows, one per rule.
  rules: { key: string; rule: string }[]
  // An empty row, in edit mode, for writing a rule from scratch.
  authoring?: { placeholder: string }
  forgetOnClose?: boolean
  grants: Task['grants']
  onAllow: (rule: string, scope: GrantScope) => Promise<boolean>
}) {
  const { open, setOpen, containerRef, triggerRef, popupRef, popupStyle } =
    useAnchoredPopup()
  const [openMenuKey, setOpenMenuKey] = useState<string | null>(null)
  const [granted, setGranted] = useState<Record<string, Granted>>({})

  useEffect(() => {
    if (open) return
    setOpenMenuKey(null)
    if (forgetOnClose) setGranted({})
  }, [open, forgetOnClose])

  const row = (key: string, rule: string, extra?: { autoEdit: true; placeholder: string }) => (
    <RuleRow
      key={key}
      rule={rule}
      grants={grants}
      menuOpen={openMenuKey === key}
      onToggleMenu={() => setOpenMenuKey((k) => (k === key ? null : key))}
      granted={granted[key] ?? null}
      onGrant={async (committed, scope) => {
        setOpenMenuKey(null)
        if (await onAllow(committed, scope))
          setGranted((g) => ({ ...g, [key]: { scope, rule: committed } }))
      }}
      {...extra}
    />
  )

  return (
    <div className={className} ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className={trigger.className}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={trigger.label}
        aria-label={trigger.label}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger.content}
      </button>
      {open && (
        <div ref={popupRef} className="rule-popup" style={popupStyle}>
          {head}
          {rules.map((r) => row(r.key, r.rule))}
          {/* Remounted fresh each time the popup reopens (the popup unmounts on
              close), so authoring another rule is one reopen. */}
          {authoring &&
            row(AUTHORING_KEY, '', { autoEdit: true, placeholder: authoring.placeholder })}
        </div>
      )}
    </div>
  )
}

// The per-turn denial-review surface at the foot of a finished assistant message:
// a muted "N permissions blocked this turn" line that opens a popup of editable
// rule rows, one per deduped denial. A granted row keeps its checkmark when the
// popup closes and reopens within this turn's summary. Only rendered when there
// are confirmed denials, so a task whose agent never reports them (codex) simply
// shows nothing.
export function BlockedSummary({
  requests,
  grants,
  onAllow,
}: {
  requests: BlockedRequest[]
  grants: Task['grants']
  onAllow: (rule: string, scope: GrantScope) => Promise<boolean>
}) {
  return (
    <RulePopup
      className="blocked-summary"
      trigger={{
        className: 'blocked-summary-line',
        content: (
          <>
            <BlockedIcon />
            {requests.length} permission{requests.length === 1 ? '' : 's'} blocked
            this turn
          </>
        ),
      }}
      rules={requests}
      grants={grants}
      onAllow={onAllow}
    />
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
// above one empty rule-authoring row with the same task/project kebab the blocked
// summary's rows carry — so a rule can be granted proactively, no archaeology
// through denied chips. The doc's primary permission surface; permission asks
// will later deep-link into it with a prefill. Each open starts fresh: an empty
// row, no checkmark.
export function GrantControl({
  grants,
  allow,
  onAllow,
}: {
  grants: Task['grants']
  // The task's own granted rules, listed above the authoring row. Absent on a
  // task that has never been granted one (and on a pre-`allow` payload).
  allow: Task['allow']
  onAllow: (rule: string, scope: GrantScope) => Promise<boolean>
}) {
  return (
    <RulePopup
      className="grant-control"
      trigger={{ className: 'title-action', label: 'Permissions', content: <StampIcon /> }}
      head={
        <>
          <GrantedRules rules={allow ?? []} honored={grants?.task ?? true} />
          <div className={'rule-popup-head' + (allow?.length ? ' divided' : '')}>
            Grant a permission rule
          </div>
        </>
      }
      rules={[]}
      authoring={{ placeholder: 'e.g. Bash(git:*)' }}
      forgetOnClose
      grants={grants}
      onAllow={onAllow}
    />
  )
}
