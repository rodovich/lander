import { useCallback, useEffect, useState } from 'react'
import { loadHooks, setHookApproval, setTrustedBranch } from './api'
import { lastPathComponent } from './format'
import type { Hook, Project, ProjectHooks } from './types'

// A project's hooks: the modules its tree declares under `.lander/hooks/`, and
// the two independent ways one comes to be allowed to run — a human approving
// that exact version, or the version being present on a branch the project
// trusts. The two are orthogonal, so they are two sections rather than one
// setting with an opposite: a hook can be approved by either, and the list comes
// first so nothing in it reads as a consequence of the branch setting.
//
// What is listed is what a commit reaches. An uncommitted hook is not pending
// approval — it is not a candidate at all — which is why nothing here offers to
// approve a working-tree file.

// The seven-character prefix a human would hand to `git show` to read the
// version in question.
function shortBlob(blob: string): string {
  return blob.slice(0, 7)
}

export function HookRow({
  hook,
  trustRootRef,
  busy,
  onSetApproval,
}: {
  hook: Hook
  trustRootRef: string | null
  busy: boolean
  onSetApproval: (hook: Hook, approved: boolean) => void
}) {
  const approvedByBranch = hook.state === 'approved' && hook.via === 'trust-root'
  const note =
    hook.state === 'approved'
      ? null
      : hook.reason === 'unapproved-version'
        ? `Not approved. An earlier approved version (${shortBlob(hook.runs ?? '')}) runs until this one is.`
        : hook.searchTruncated
          ? 'Not approved, and no approved earlier version was found. This hook will not run.'
          : 'Not approved. This hook will not run.'
  return (
    <li className="hook-row">
      <div className="hook-row-head">
        <span className="hook-name">{hook.name}</span>
        <span className="hook-trigger">
          {hook.trigger} • {hook.by}
        </span>
        <span className="hook-blob">{shortBlob(hook.blob)}</span>
        {approvedByBranch ? (
          <span className="hook-state approved">
            On {trustRootRef ?? 'the trusted branch'}
          </span>
        ) : hook.state === 'approved' ? (
          <button
            type="button"
            className="hook-action"
            disabled={busy}
            onClick={() => onSetApproval(hook, false)}
          >
            Withdraw
          </button>
        ) : (
          <button
            type="button"
            className="hook-action hook-approve"
            disabled={busy}
            onClick={() => onSetApproval(hook, true)}
          >
            Approve
          </button>
        )}
      </div>
      <div className="hook-path">{hook.path}</div>
      {note && <div className="hook-note">{note}</div>}
    </li>
  )
}

// The branch setting. An empty field is not "approval disabled" — it is simply
// no branch named, with content approval unaffected either way.
export function TrustedBranch({
  hooks,
  busy,
  onSave,
}: {
  hooks: ProjectHooks
  busy: boolean
  onSave: (ref: string | null) => void
}) {
  const current = hooks.trustRoot.ref ?? ''
  const [draft, setDraft] = useState(current)
  // Follow the server's value when it changes underneath (a save, a reload, a
  // switch to another project) without stranding an edit in progress.
  useEffect(() => setDraft(current), [current])
  const dirty = draft.trim() !== current
  return (
    <section className="hooks-section">
      <h3 className="hooks-section-title">Trusted branch</h3>
      <p className="hooks-note">
        Hooks present on this branch will run on your computer without requiring
        individual approval.
      </p>
      <form
        className="hooks-branch-form"
        onSubmit={(e) => {
          e.preventDefault()
          onSave(draft.trim() || null)
        }}
      >
        <input
          className="hooks-branch-input"
          type="text"
          value={draft}
          placeholder="origin/main"
          aria-label="Trusted branch"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="hook-action" disabled={busy || !dirty}>
          Save
        </button>
      </form>
      {hooks.trustRoot.ref && hooks.trustRoot.reason === 'unresolved-ref' && (
        <div className="hooks-note hooks-note-warn">
          No branch named {hooks.trustRoot.ref} in this checkout.
        </div>
      )}
      {hooks.trustRoot.commit && (
        <div className="hooks-note">
          Currently at {shortBlob(hooks.trustRoot.commit)}.
        </div>
      )}
    </section>
  )
}

// The list section, and what to say when there is nothing in it. "No hooks" and
// "nothing could be read" are different facts and read differently.
//
// No heading of its own: the panel's title is this section's, and repeating it
// directly above the list reads as a stutter. The trusted-branch section below
// needs one because it follows something.
export function HooksList({
  hooks,
  busy,
  onSetApproval,
}: {
  hooks: ProjectHooks
  busy: boolean
  onSetApproval: (hook: Hook, approved: boolean) => void
}) {
  return (
    <section className="hooks-section">
      {hooks.reason === 'not-a-repo' ? (
        <p className="hooks-note">
          This project is not a git repository, so it declares no hooks.
        </p>
      ) : hooks.hooks.length === 0 ? (
        <p className="hooks-note">
          This project declares no hooks. A hook is a committed module at{' '}
          <code>.lander/hooks/&lt;trigger&gt;/&lt;by&gt;/&lt;name&gt;.js</code>.
        </p>
      ) : (
        <ul className="hook-list">
          {hooks.hooks.map((hook) => (
            <HookRow
              key={hook.path}
              hook={hook}
              trustRootRef={hooks.trustRoot.ref}
              busy={busy}
              onSetApproval={onSetApproval}
            />
          ))}
        </ul>
      )}
    </section>
  )
}

// The panel proper: picks the project, loads its hooks, and reloads after every
// change, since approving a version can change what a different path resolves to.
export function HooksPanel({
  projects,
  slug,
  setSlug,
  onClose,
}: {
  projects: Project[]
  slug: string
  setSlug: (slug: string) => void
  onClose: () => void
}) {
  const [hooks, setHooks] = useState<ProjectHooks | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      setHooks(await loadHooks(slug))
      setError(null)
    } catch (e) {
      setHooks(null)
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [slug])

  useEffect(() => {
    void reload()
  }, [reload])

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await run()
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hooks-panel">
      <div className="hooks-head">
        <h2 className="hooks-title">Hooks</h2>
        {projects.length > 1 && (
          <select
            className="hooks-project"
            value={slug}
            aria-label="Project"
            onChange={(e) => setSlug(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {lastPathComponent(p.path)}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="hook-action" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {hooks && (
        <>
          <HooksList
            hooks={hooks}
            busy={busy}
            onSetApproval={(hook, approved) =>
              void act(() => setHookApproval(slug, hook, approved))
            }
          />
          <TrustedBranch
            hooks={hooks}
            busy={busy}
            onSave={(ref) => void act(() => setTrustedBranch(slug, ref))}
          />
        </>
      )}
    </div>
  )
}
