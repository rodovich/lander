import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { HookRow, HooksList, TrustedBranch } from './hooksPanel'
import type { Hook, ProjectHooks } from './types'

const HOOK: Hook = {
  path: '.lander/hooks/landed/any/cleanup.js',
  blob: 'b10bb10bb10bb10bb10bb10bb10bb10bb10bb10b',
  trigger: 'landed',
  by: 'any',
  name: 'cleanup',
  state: 'pending',
  runs: null,
  reason: 'no-approved-version',
}

const row = (hook: Partial<Hook>, trustRootRef: string | null = null) =>
  renderToStaticMarkup(
    <HookRow
      hook={{ ...HOOK, ...hook }}
      trustRootRef={trustRootRef}
      busy={false}
      onSetApproval={() => {}}
    />,
  )

const hooks = (over: Partial<ProjectHooks> = {}): ProjectHooks => ({
  cwd: '/proj',
  commit: 'c0ffee',
  trustRoot: { ref: null, configured: false },
  hooks: [],
  ...over,
})

describe('HookRow', () => {
  it('offers approval for a version nobody has approved, and says what that means', () => {
    const html = row({})
    expect(html).toContain('Approve')
    expect(html).toContain('This hook will not run.')
    expect(html).not.toContain('Withdraw')
  })

  // The declared version being unapproved does not block anything — an earlier
  // approved version keeps running — so the row must not read as "broken".
  it('names the earlier version that runs in the meantime', () => {
    const html = row({ runs: 'a11ce00', reason: 'unapproved-version' })
    expect(html).toContain('An earlier approved version (a11ce00) runs')
  })

  it('offers withdrawal for a version a human approved', () => {
    const html = row({ state: 'approved', via: 'content', runs: HOOK.blob })
    expect(html).toContain('Withdraw')
    expect(html).not.toContain('Approve')
  })

  // The two mechanisms are independent, so a hook allowed by the branch is not
  // shown as something anyone approved here — and offers no withdrawal, because
  // withdrawing it means not trusting the branch.
  it('attributes a branch-approved version to the branch, with no action', () => {
    const html = row(
      { state: 'approved', via: 'trust-root', runs: HOOK.blob },
      'origin/main',
    )
    expect(html).toContain('On origin/main')
    expect(html).not.toContain('Withdraw')
    expect(html).not.toContain('>Approve<')
  })

  it('shows the short blob, so the version can be read with git', () => {
    expect(row({})).toContain('b10bb10')
  })

  // `searchTruncated` says the walk back through this path's history stopped at
  // its limit — so it WEAKENS "no approved version", and the row must not read as
  // the more certain of the two.
  it('hedges when the search for an earlier approved version was cut short', () => {
    const html = row({ searchTruncated: true })
    expect(html).toContain('recent history')
    expect(html).not.toContain('This hook will not run.')
    expect(row({})).toContain('This hook will not run.')
  })
})

describe('HooksList', () => {
  const render = (over: Partial<ProjectHooks>) =>
    renderToStaticMarkup(
      <HooksList hooks={hooks(over)} busy={false} onSetApproval={() => {}} />,
    )

  it('says a project declares none, and where one would live', () => {
    const html = render({})
    expect(html).toContain('declares no hooks')
    expect(html).toContain('.lander/hooks/')
  })

  // "No hooks" and "there is no repository to read hooks from" are different
  // facts, and only one of them is about hooks.
  it('distinguishes a project that is not a repository', () => {
    const html = render({ reason: 'not-a-repo', commit: undefined })
    expect(html).toContain('not a git repository')
    expect(html).not.toContain('This project declares no hooks')
  })

  it('lists what the tree declares', () => {
    const html = render({ hooks: [HOOK] })
    expect(html).toContain('cleanup')
    expect(html).toContain('.lander/hooks/landed/any/cleanup.js')
  })
})

describe('TrustedBranch', () => {
  const render = (over: Partial<ProjectHooks['trustRoot']> = {}) =>
    renderToStaticMarkup(
      <TrustedBranch
        hooks={hooks({ trustRoot: { ref: null, configured: false, ...over } })}
        busy={false}
        onSave={() => {}}
      />,
    )

  // Stated as what happens, not as a warning: naming a branch here means its
  // hooks run on this machine unattended, and that is the whole of it.
  it('describes what naming a branch does', () => {
    expect(render()).toContain(
      'Hooks present on this branch will run on your computer without requiring individual approval.',
    )
  })

  it('shows the named branch and where it currently points', () => {
    const html = render({ ref: 'origin/main', configured: true, commit: 'c0ffeeb' })
    expect(html).toContain('value="origin/main"')
    expect(html).toContain('Currently at c0ffeeb')
  })

  it('says when the named branch is not in this checkout', () => {
    const html = render({
      ref: 'origin/nope',
      configured: true,
      reason: 'unresolved-ref',
    })
    expect(html).toContain('No remote-tracking branch named origin/nope')
    // And says what one is, since "origin/nope" and "nope" fail identically.
    expect(html).toContain('a local branch is not one')
  })

  it('leaves the field empty when no branch is named', () => {
    expect(render()).toContain('value=""')
  })
})
