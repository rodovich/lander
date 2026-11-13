// A reference to an element on the app's page, written for an agent that will
// look for it in the app's source rather than in a live page.

const MAX_TEXT = 200
const MAX_ATTRIBUTE = 80

// Attributes that name an element on purpose, so they tend to survive edits
// and appear verbatim in the source.
const NAMING_ATTRIBUTES = ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label']

// Class names shaped like a build tool's, which are likely nowhere in the
// source: a CSS-in-JS or Svelte prefix before a hash with a digit or a capital
// letter, or a CSS modules hash with a digit after `_` or `__`. Hand-written
// names of those shapes are left out too.
const GENERATED_CLASS = /^(css|sc|jsx|emotion|svelte)-(?=[\w-]*[\dA-Z])|(^_|__)(?=[\w-]*\d)[\w-]{5,}$/

const quoted = JSON.stringify

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim()

function isUnique(selector: string) {
  try {
    return document.querySelectorAll(selector).length === 1
  } catch {
    return false
  }
}

export function sourceClasses(element: Element) {
  return [...element.classList].filter((name) => !GENERATED_CLASS.test(name))
}

// The element's own part of a selector.
function segment(element: Element) {
  if (element.id) return `#${CSS.escape(element.id)}`
  let selector = element.localName
  const name = NAMING_ATTRIBUTES.find((attribute) => element.getAttribute(attribute))
  if (name) selector += `[${name}=${quoted(element.getAttribute(name)!)}]`
  return selector + sourceClasses(element).map((name) => `.${CSS.escape(name)}`).join('')
}

function nthOfType(element: Element) {
  const parent = element.parentElement
  if (!parent) return element.localName
  const sameType = [...parent.children].filter((child) => child.localName === element.localName)
  return sameType.length === 1
    ? element.localName
    : `${element.localName}:nth-of-type(${sameType.indexOf(element) + 1})`
}

// The first selector found, working outward from the element's own part, that
// matches only this element. Positions among siblings are the last resort,
// since a reader can't find them in the source.
export function uniqueSelector(element: Element): string {
  const own = segment(element)
  if (isUnique(own)) return own
  let selector = own
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const part = segment(ancestor)
    if (part === ancestor.localName) continue
    selector = `${part} ${selector}`
    if (isUnique(selector)) return selector
    if (ancestor.id) break
  }
  const path: string[] = []
  for (let node: Element | null = element; node; node = node.parentElement) {
    const id = node !== element && node.id ? segment(node) : null
    if (id && isUnique(id)) {
      path.unshift(id)
      break
    }
    path.unshift(nthOfType(node))
  }
  return path.join(' > ')
}

const IMPLICIT_ROLES: Record<string, string> = {
  a: 'link',
  article: 'article',
  aside: 'complementary',
  button: 'button',
  dialog: 'dialog',
  footer: 'contentinfo',
  form: 'form',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  header: 'banner',
  img: 'img',
  li: 'listitem',
  main: 'main',
  nav: 'navigation',
  ol: 'list',
  option: 'option',
  section: 'region',
  select: 'combobox',
  table: 'table',
  textarea: 'textbox',
  ul: 'list',
}

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  search: 'searchbox',
  submit: 'button',
}

// Roles whose accessible name falls back on the element's own text.
const NAMED_BY_CONTENT = new Set([
  'button',
  'checkbox',
  'heading',
  'link',
  'menuitem',
  'option',
  'radio',
  'tab',
])

function role(element: Element) {
  const explicit = element.getAttribute('role')
  if (explicit) return explicit.split(/\s+/)[0]
  if (element.localName === 'a' && !element.hasAttribute('href')) return null
  if (element instanceof HTMLInputElement) return INPUT_ROLES[element.type] ?? 'textbox'
  return IMPLICIT_ROLES[element.localName] ?? null
}

// The accessible name from its common sources, in the order browsers try
// them, without the full algorithm's recursion into labelling elements.
function accessibleName(element: Element, elementRole: string, text: string) {
  const labelledBy = element.getAttribute('aria-labelledby')
  const sources = [
    labelledBy
      ?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' '),
    element.getAttribute('aria-label'),
  ]
  if (element instanceof HTMLImageElement) sources.push(element.alt)
  if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type))
    sources.push(element.value)
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    sources.push([...(element.labels ?? [])].map((label) => label.textContent ?? '').join(' '))
  }
  if (NAMED_BY_CONTENT.has(elementRole)) sources.push(text)
  sources.push(element.getAttribute('title'))
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
    sources.push(element.placeholder)
  for (const source of sources) {
    const name = collapse(source ?? '')
    if (name) return name
  }
  return null
}

function visibleText(element: Element) {
  const text = element instanceof HTMLElement ? element.innerText : element.textContent
  return collapse(text ?? '')
}

function openingTag(element: Element) {
  const attributes = [...element.attributes].map((attribute) =>
    attribute.value === ''
      ? attribute.name
      : `${attribute.name}=${quoted(truncate(attribute.value, MAX_ATTRIBUTE))}`,
  )
  return `<${[element.localName, ...attributes].join(' ')}>`
}

export function describeElement(element: Element): string {
  const box = element.getBoundingClientRect()
  const text = visibleText(element)
  const elementRole = role(element)
  const name = elementRole && accessibleName(element, elementRole, text)
  const lines = [
    `Element on ${location.href} (viewport ${innerWidth}×${innerHeight})`,
    `selector: ${uniqueSelector(element)}`,
  ]
  if (elementRole) lines.push(`role: ${elementRole}${name ? ` ${quoted(truncate(name, MAX_TEXT))}` : ''}`)
  if (text && text !== name) lines.push(`text: ${quoted(truncate(text, MAX_TEXT))}`)
  lines.push(`html: ${openingTag(element)}`)
  lines.push(
    `box: ${Math.round(box.width)}×${Math.round(box.height)} at (${Math.round(box.left)}, ${Math.round(box.top)})`,
  )
  return lines.join('\n') + '\n'
}
