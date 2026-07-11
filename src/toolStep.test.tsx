import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolStep } from './toolStep'
import type { ToolItem } from './types'

// Minimal props for a tool chip render. renderToStaticMarkup gives the initial
// (effect-free) markup, which is all we need: the disclosure body is gated on
// `detailOpen`, not on a mounted effect, so an open chip renders its revealed
// content synchronously.
const AT = '2026-01-01T00:00:00.000Z'
const item = (over: Partial<ToolItem>): ToolItem => ({
  id: 't1',
  at: AT,
  rideId: 'r1',
  kind: 'tool',
  name: 'Bash',
  input: 'ls',
  status: 'ok',
  ...over,
})
const render = (over: Partial<ToolItem>) =>
  renderToStaticMarkup(
    <ToolStep item={item(over)} detailOpen={true} onToggleDetail={() => {}} />,
  )

describe('ToolStep input disclosure', () => {
  it('reveals the untruncated inputFull under an open chip', () => {
    const html = render({
      input: 'echo one echo two',
      inputFull: 'echo one\necho two',
    })
    expect(html).toContain('step-input')
    // The full, newline-preserving text is what the revealed block carries.
    expect(html).toContain('echo one\necho two')
    // A chip with revealable detail gets the disclosure toggle.
    expect(html).toContain('Hide input')
  })

  it('reveals a multi-line legacy input via the fallback, with no inputFull', () => {
    const html = render({ input: 'line one\nline two' })
    expect(html).toContain('step-input')
    expect(html).toContain('line one\nline two')
  })

  it('renders a short single-line call as a plain chip with no disclosure', () => {
    const html = render({ input: 'ls' })
    expect(html).not.toContain('step-input')
    // No revealable detail ⇒ no disclosure toggle, and the chip is a plain,
    // non-interactive label (a <span>), not a button.
    expect(html).not.toContain('collapsible-toggle')
    expect(html).toContain('collapsible-row')
    expect(html).toContain('step-tool-name plain')
    expect(html).toContain('<span class="step-tool-name plain">Bash</span>')
  })

  it('shows the input above a landed output when the call has both', () => {
    const html = render({
      input: 'echo hi echo bye',
      inputFull: 'echo hi\necho bye',
      output: 'hi\nbye',
    })
    const inputAt = html.indexOf('step-input')
    const resultAt = html.indexOf('step-result')
    expect(inputAt).toBeGreaterThanOrEqual(0)
    expect(resultAt).toBeGreaterThan(inputAt)
  })

  it('marks a blocked call’s chip and output as errored', () => {
    const html = render({ input: 'rm -rf /', output: 'denied', status: 'blocked' })
    expect(html).toContain('step-tool-name errored')
    expect(html).toContain('step-result errored')
  })
})
