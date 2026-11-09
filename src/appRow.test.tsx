import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AppRowView } from './appRow'

describe('AppRowView', () => {
  it('renders nothing for a project with no app', () => {
    expect(renderToStaticMarkup(<AppRowView state={null} />)).toBe('')
  })

  it('links to a listening app, without the scheme in its text', () => {
    const html = renderToStaticMarkup(
      <AppRowView state={{ url: 'http://localhost:3860/', listening: true }} />,
    )
    expect(html).toContain('href="http://localhost:3860/"')
    expect(html).toContain('>localhost:3860</a>')
  })

  it.each([
    [{ url: 'http://localhost:3860', listening: false }],
    [{ listening: false }],
  ])('says the app is not running for %j', (state) => {
    const html = renderToStaticMarkup(<AppRowView state={state} />)
    expect(html).toContain('>Not running<')
    expect(html).not.toContain('<a ')
  })

  it('says so when the daemon cannot answer', () => {
    expect(renderToStaticMarkup(<AppRowView state="unavailable" />)).toContain(
      '>Status unavailable<',
    )
  })
})
