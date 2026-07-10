import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BlockedSummary, GrantControl, RuleRow } from './App'

const noop = async () => true

describe('BlockedSummary line', () => {
  it('summarizes the denial count, pluralizing', () => {
    const two = renderToStaticMarkup(
      <BlockedSummary
        requests={[
          { key: 'a', rule: 'Bash(git push)', tool: 'Bash' },
          { key: 'b', rule: 'WebFetch(https://x)', tool: 'WebFetch' },
        ]}
        agent="claude"
        onAllow={noop}
      />,
    )
    expect(two).toContain('2 permissions blocked')
    const one = renderToStaticMarkup(
      <BlockedSummary
        requests={[{ key: 'a', rule: 'Bash(ls)', tool: 'Bash' }]}
        agent="claude"
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
        agent="claude"
        menuOpen={false}
        onToggleMenu={() => {}}
        onAllow={noop}
        granted={null}
        onGranted={() => {}}
        {...props}
      />,
    )

  it('shows the rule read-only with a kebab by default', () => {
    const html = render()
    expect(html).toContain('Bash(git push)')
    expect(html).toContain('rule-row-kebab')
    // Menu is closed, so no scope items yet.
    expect(html).not.toContain('Allow in task')
  })

  it('opens both grant scopes for a claude task when the menu is open', () => {
    const html = render({ menuOpen: true })
    expect(html).toContain('Allow in task')
    expect(html).toContain('Allow in project')
  })

  it('relabels task scope and disables project scope for codex', () => {
    const html = render({ menuOpen: true, agent: 'codex' })
    expect(html).toContain('Save rule')
    expect(html).toContain('Project unsupported')
    expect(html).toContain('disabled')
  })

  it('shows a checkmark and no kebab once granted', () => {
    const html = render({ granted: 'task' })
    expect(html).toContain('rule-row-granted')
    expect(html).not.toContain('rule-row-kebab')
  })

  it('starts in edit mode with a placeholder for an empty authoring row', () => {
    const html = render({ rule: '', autoEdit: true, placeholder: 'Author a rule…' })
    expect(html).toContain('rule-row-input')
    expect(html).toContain('Author a rule…')
    // An empty rule leaves the kebab disabled (nothing to grant yet).
    expect(html).toContain('disabled')
  })
})

describe('GrantControl', () => {
  it('renders a labelled stamp trigger (popup opens on click, not in SSR)', () => {
    const html = renderToStaticMarkup(
      <GrantControl agent="claude" onAllow={noop} />,
    )
    expect(html).toContain('aria-label="Grant a permission rule"')
    // Closed by default: no popup/rule row in the initial markup.
    expect(html).not.toContain('rule-row')
  })
})
