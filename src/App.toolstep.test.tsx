import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolStep } from './App'

// Minimal props for a tool_use chip render. renderToStaticMarkup gives the
// initial (effect-free) markup, which is all we need: the disclosure body is
// gated on `detailOpen`, not on a mounted effect, so an open chip renders its
// revealed content synchronously.
const render = (step: any, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    <ToolStep
      step={step}
      status="ok"
      result={undefined}
      detailOpen={true}
      onToggleDetail={() => {}}
      {...extra}
    />,
  )

describe('ToolStep input disclosure', () => {
  it('reveals the untruncated inputFull under an open chip', () => {
    const html = render({
      kind: 'tool_use',
      tool: 'Bash',
      input: 'echo one echo two',
      inputFull: 'echo one\necho two',
      toolUseId: 't1',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(html).toContain('step-input')
    // The full, newline-preserving text is what the revealed block carries.
    expect(html).toContain('echo one\necho two')
    // A chip with revealable detail gets the disclosure toggle.
    expect(html).toContain('Hide input')
  })

  it('reveals a multi-line legacy input via the fallback, with no inputFull', () => {
    const html = render({
      kind: 'tool_use',
      tool: 'Bash',
      input: 'line one\nline two',
      toolUseId: 't2',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(html).toContain('step-input')
    expect(html).toContain('line one\nline two')
  })

  it('renders a short single-line call as a plain chip with no disclosure', () => {
    const html = render({
      kind: 'tool_use',
      tool: 'Bash',
      input: 'ls',
      toolUseId: 't3',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect(html).not.toContain('step-input')
    // No revealable detail ⇒ no disclosure toggle, and the chip is a plain,
    // non-interactive label (a <span>), not a button.
    expect(html).not.toContain('collapsible-toggle')
    expect(html).toContain('collapsible-row')
    expect(html).toContain('step-tool-name plain')
    expect(html).toContain('<span class="step-tool-name plain">Bash</span>')
  })

  it('shows the input above a landed output when the call has both', () => {
    const html = render(
      {
        kind: 'tool_use',
        tool: 'Bash',
        input: 'echo hi echo bye',
        inputFull: 'echo hi\necho bye',
        toolUseId: 't4',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      { result: { text: 'hi\nbye', isError: false } },
    )
    const inputAt = html.indexOf('step-input')
    const resultAt = html.indexOf('step-result')
    expect(inputAt).toBeGreaterThanOrEqual(0)
    expect(resultAt).toBeGreaterThan(inputAt)
  })
})
