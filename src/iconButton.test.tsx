import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { IconButton } from './iconButton'

describe('IconButton', () => {
  it('uses label as both aria-label and title by default', () => {
    expect(renderToStaticMarkup(<IconButton label="Close">x</IconButton>)).toBe(
      '<button type="button" class="icon-button" title="Close" aria-label="Close">x</button>',
    )
  })

  it('lets title override or suppress the tooltip while keeping aria-label', () => {
    expect(
      renderToStaticMarkup(
        <IconButton label="Attach files" title="Attach files or drop them here">
          x
        </IconButton>,
      ),
    ).toBe(
      '<button type="button" class="icon-button" title="Attach files or drop them here" aria-label="Attach files">x</button>',
    )
    expect(
      renderToStaticMarkup(
        <IconButton label="Task actions" title={null}>
          x
        </IconButton>,
      ),
    ).toBe('<button type="button" class="icon-button" aria-label="Task actions">x</button>')
  })
})
