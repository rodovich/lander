import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorBoundary } from './errorBoundary'

describe('ErrorBoundary', () => {
  it('renders its children, or what a function child returns', () => {
    expect(
      renderToStaticMarkup(
        <ErrorBoundary label="this entry">
          <p>child</p>
        </ErrorBoundary>,
      ),
    ).toBe('<p>child</p>')
    expect(
      renderToStaticMarkup(
        <ErrorBoundary label="this entry">{() => <p>child</p>}</ErrorBoundary>,
      ),
    ).toBe('<p>child</p>')
  })

  it('shows what failed and why in place of the children', () => {
    // Server rendering never catches into a boundary, so this puts the
    // boundary in the state React's client renderer gives it after a throw.
    const boundary = new ErrorBoundary({ label: 'this entry', children: <p>child</p> })
    boundary.state = {
      ...boundary.state,
      ...ErrorBoundary.getDerivedStateFromError(new TypeError('bad payload')),
    }
    const html = renderToStaticMarkup(<>{boundary.render()}</>)
    expect(html).toContain('role="alert"')
    expect(html).toContain('render this entry: bad payload')
    expect(html).not.toContain('child')
  })
})
