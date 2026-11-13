import { sourceClasses } from './describeElement'

// What the overlay labels the element under the pointer with, as DevTools does.
function label(element: Element, box: DOMRect) {
  const id = element.id ? `#${element.id}` : ''
  const classes = sourceClasses(element).slice(0, 2).map((name) => `.${name}`)
  return `${element.localName}${id}${classes.join('')}  ${Math.round(box.width)}×${Math.round(box.height)}`
}

// Lets the user point at an element on the page and click to pick it, like
// DevTools' inspector. A layer over the whole page takes the pointer, so no
// element there is hovered or clicked, stops presses and clicks from bubbling
// to the page's own listeners, and outlines the element beneath it. Resolves
// with the element clicked, or null on Escape.
export function pickElement(root: ShadowRoot, host: Element): Promise<Element | null> {
  const layer = document.createElement('div')
  layer.className = 'pick-layer'
  layer.tabIndex = -1
  const outline = document.createElement('div')
  outline.className = 'pick-outline'
  const tag = document.createElement('div')
  tag.className = 'pick-label'
  outline.hidden = tag.hidden = true
  layer.append(outline, tag)
  root.append(layer)
  layer.focus()

  let pointer: { x: number; y: number } | null = null
  let target: Element | null = null

  function elementAt(x: number, y: number) {
    return document.elementsFromPoint(x, y).find((element) => element !== host) ?? null
  }

  function show() {
    target = pointer && elementAt(pointer.x, pointer.y)
    outline.hidden = tag.hidden = !target
    if (!target) return
    const box = target.getBoundingClientRect()
    Object.assign(outline.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    })
    tag.textContent = label(target, box)
    const above = box.top - tag.offsetHeight - 4
    const top = above >= 0 ? above : box.bottom + 4
    tag.style.top = `${Math.min(top, innerHeight - tag.offsetHeight)}px`
    tag.style.left = `${Math.max(0, Math.min(box.left, innerWidth - tag.offsetWidth))}px`
  }

  return new Promise((resolve) => {
    const keep = (event: Event) => event.stopPropagation()
    const kept = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']

    function finish(element: Element | null) {
      layer.remove()
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', show, true)
      window.removeEventListener('resize', show)
      resolve(element)
    }

    // On the window, so Escape works wherever focus has gone, and before the
    // page's own Escape handlers, which would otherwise close its dialogs too.
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      finish(null)
    }

    for (const type of kept) layer.addEventListener(type, keep)
    layer.addEventListener('pointermove', (event) => {
      event.stopPropagation()
      pointer = { x: event.clientX, y: event.clientY }
      show()
    })
    layer.addEventListener('click', (event) => {
      event.stopPropagation()
      pointer = { x: event.clientX, y: event.clientY }
      show()
      if (target) finish(target)
    })
    window.addEventListener('keydown', onKey, true)
    // Scrolling moves the page under a pointer that stays put.
    window.addEventListener('scroll', show, true)
    window.addEventListener('resize', show)
  })
}
