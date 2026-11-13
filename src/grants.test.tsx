import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BlockedSummary, GrantControl, GrantedRules, grantScopes, RuleRow } from './grants'

const noop = async () => true

describe('BlockedSummary line', () => {
  it('summarizes the denial count, pluralizing', () => {
    const two = renderToStaticMarkup(
      <BlockedSummary
        requests={[
          { key: 'a', rule: 'Bash(git push)', tool: 'Bash' },
          { key: 'b', rule: 'WebFetch(https://x)', tool: 'WebFetch' },
        ]}
        grants={{ task: true, project: true }}
        onAllow={noop}
      />,
    )
    expect(two).toContain('2 permissions blocked')
    const one = renderToStaticMarkup(
      <BlockedSummary
        requests={[{ key: 'a', rule: 'Bash(ls)', tool: 'Bash' }]}
        grants={{ task: true, project: true }}
        onAllow={noop}
      />,
    )
    expect(one).toContain('1 permission blocked')
    expect(one).not.toContain('1 permissions blocked')
  })
})

describe('RuleRow', () => {
  const render = (props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <RuleRow
        rule="Bash(git push)"
        grants={{ task: true, project: true }}
        granted={null}
        onGrant={() => {}}
        {...props}
      />,
    )

  it('shows the rule read-only with a kebab by default', () => {
    const html = render()
    expect(html).toContain('Bash(git push)')
    expect(html).toContain('aria-label="Grant scope"')
    // Menu is closed, so no scope items yet.
    expect(html).not.toContain('Allow in task')
  })

  it('offers each grant scope the flow supports', () => {
    expect(grantScopes({ task: true, project: true })).toEqual(['task', 'project'])
    expect(grantScopes({ task: false, project: true })).toEqual(['project'])
    expect(grantScopes({ task: true, project: false })).toEqual(['task'])
  })

  const grantedAs = { scope: 'task', rule: 'Bash(git push)' }

  it('shows a checkmark and no kebab once granted', () => {
    const html = render({ granted: grantedAs })
    expect(html).toContain('rule-row-granted')
    expect(html).not.toContain('aria-label="Grant scope"')
  })

  it('renders the rule read-only (not click-to-edit) once granted', () => {
    const html = render({ granted: grantedAs })
    expect(html).toContain('rule-row-rule readonly')
    expect(html).not.toContain('Click to edit')
    const ungranted = render()
    expect(ungranted).toContain('Click to edit')
  })

  // A denial row reopened after its rule was edited and granted: the row is
  // freshly mounted with the denied text, but what it records is what was allowed.
  it('names the rule as granted, not as it was first seeded', () => {
    const html = render({
      rule: 'Bash(git log --oneline)',
      granted: { scope: 'project', rule: 'Bash(git:*)' },
    })
    expect(html).toContain('Bash(git:*)')
    expect(html).not.toContain('git log')
    expect(html).toContain('title="Allowed in project"')
  })

  it('starts in edit mode with a placeholder for an empty authoring row', () => {
    const html = render({
      rule: '',
      autoEdit: true,
      grants: { task: true, project: true, placeholder: 'Author a rule…' },
    })
    expect(html).toContain('rule-row-input')
    expect(html).toContain('Author a rule…')
    // An empty rule leaves the kebab disabled (nothing to grant yet).
    expect(html).toContain('disabled')
  })
})

describe('GrantControl', () => {
  it('renders a labeled stamp trigger when task or project grants are supported', () => {
    const html = renderToStaticMarkup(
      <GrantControl
        grants={{ task: true, project: true }}
        allow={['Bash(git:*)']}
        onAllow={noop}
      />,
    )
    expect(html).toContain('aria-label="Permissions"')
    // Closed by default: no popup, rule row, or granted rule in the markup.
    expect(html).not.toContain('rule-row')
    expect(html).not.toContain('Bash(git:*)')

    const projectOnly = renderToStaticMarkup(
      <GrantControl
        grants={{ task: false, project: true }}
        allow={undefined}
        onAllow={noop}
      />,
    )
    expect(projectOnly).toContain('aria-label="Permissions"')
  })

  it('renders nothing when neither task nor project grants are supported (codex)', () => {
    const html = renderToStaticMarkup(
      <GrantControl
        grants={{ task: false, project: false }}
        allow={undefined}
        onAllow={noop}
      />,
    )
    expect(html).toBe('')
  })
})

describe('GrantedRules', () => {
  it('lists the task’s granted rules read-only', () => {
    const html = renderToStaticMarkup(
      <GrantedRules rules={['Bash(git:*)', 'WebFetch(https://x)']} />,
    )
    expect(html).toContain('Allowed in this task')
    expect(html).toContain('Bash(git:*)')
    expect(html).toContain('WebFetch(https://x)')
    // Read-only: no click-to-edit, no kebab to grant them again.
    expect(html).toContain('rule-row-rule readonly')
    expect(html).not.toContain('aria-label="Grant scope"')
  })

  it('renders nothing when the task has no rules', () => {
    expect(renderToStaticMarkup(<GrantedRules rules={[]} />)).toBe('')
  })
})
