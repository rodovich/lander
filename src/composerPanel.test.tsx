import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ComposerPanel } from './composerPanel'
import type { ComponentProps } from 'react'

const render = (over: Partial<ComponentProps<typeof ComposerPanel>> = {}) =>
  renderToStaticMarkup(
    <ComposerPanel
      className="composer-bar"
      height={150}
      value="a draft"
      onChange={() => {}}
      onSubmit={() => {}}
      placeholder="Reply…"
      rows={3}
      files={[]}
      onAddFiles={() => {}}
      onClearFiles={() => {}}
      {...over}
    />,
  )

describe('ComposerPanel', () => {
  it('wears the caller class and the dragged height', () => {
    const html = render()
    expect(html).toContain('class="composer-bar"')
    expect(html).toContain('style="height:150px"')
  })

  it('is a div by default and a form when submitting is its purpose', () => {
    expect(render()).toMatch(/^<div/)
    expect(render({ as: 'form' })).toMatch(/^<form/)
  })

  it('puts the head above the textarea and the actions in the action row', () => {
    const html = render({
      head: <h2>New task</h2>,
      actions: <button type="submit">Launch</button>,
    })
    expect(html.indexOf('New task')).toBeLessThan(html.indexOf('<textarea'))
    expect(html.indexOf('<textarea')).toBeLessThan(
      html.indexOf('class="composer-actions"'),
    )
    expect(html.indexOf('class="composer-actions"')).toBeLessThan(
      html.indexOf('Launch'),
    )
  })

  it('carries the draft and its placeholder into the textarea', () => {
    const html = render({ textareaClassName: 'composer' })
    expect(html).toContain('placeholder="Reply…"')
    expect(html).toContain('class="composer"')
    expect(html).toContain('a draft</textarea>')
  })

  // A busy panel stops taking files, but only the reply bar locks its textarea;
  // the new-task form keeps taking the next draft while one is launching.
  it('locks the textarea only when the caller asks it to', () => {
    const textarea = (html: string) => html.match(/<textarea[^>]*>/)![0]
    expect(textarea(render({ busy: true }))).not.toContain('disabled')
    expect(textarea(render({ textareaDisabled: true }))).toContain('disabled')
    expect(render({ busy: true })).toContain(
      '<button type="button" class="attach-btn" title="Attach files or drop them here" aria-label="Attach files" disabled="">',
    )
  })

  it('drops the paperclip where there is nothing to attach to', () => {
    expect(render()).toContain('aria-label="Attach files"')
    expect(render({ showAttach: false })).not.toContain(
      'aria-label="Attach files"',
    )
  })

  it('names the attached files on the attach control', () => {
    const html = render({ files: [new File(['x'], 'notes.txt')] })
    expect(html).toContain('notes.txt')
  })
})
