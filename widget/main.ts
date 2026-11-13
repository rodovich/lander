// The lander widget, which runs only as the classic script the web server
// bundles at /widget.js: `document.currentScript` is null in a module.
import type { Gallery } from '../src/attachments'
import { describeElement } from './describeElement'
import { PREVIEW_PARAM, type EmbedMessage, type WidgetMessage } from './messages'
import { keepOwnPresses } from './ownPresses'
import { pickElement } from './picker'
import styles from './widget.css?inline'

const script = document.currentScript as HTMLScriptElement
const embedUrl = script.dataset.embedUrl
if (!embedUrl) throw new Error('lander widget: the script tag has no data-embed-url')
const iconUrl = new URL('/favicon.svg', script.src)

const OPEN_KEY = 'lander-widget-open'
// The page's styles reach only this element, which no ordinary page rule
// names, and the widget's styles stay in its shadow root. With the largest
// z-index there is, only the page's top layer, such as a modal <dialog>, can
// cover it.
const host = document.createElement('lander-widget')
const onOwnPress = keepOwnPresses(host)
const root = host.attachShadow({ mode: 'open' })
root.innerHTML = `
  <style>${styles}</style>
  <div class="panel" hidden></div>
  <button type="button" class="toggle" aria-label="lander" aria-expanded="false">
    <img alt="" src="${iconUrl}" />
  </button>
`
const panel = root.querySelector<HTMLElement>('.panel')!
const toggle = root.querySelector<HTMLButtonElement>('.toggle')!

// The frame runs from the start, closed or not, so the button can show the
// task's state, and closing the panel only hides it.
const frame = document.createElement('iframe')
frame.title = 'lander task'
// A cross-origin frame can write to the clipboard only if its embedder
// delegates the permission.
frame.allow = 'clipboard-write'
frame.src = embedUrl
panel.append(frame)
const embedOrigin = new URL(embedUrl).origin
let embedReady = false

function tellEmbed(message: WidgetMessage, target = frame) {
  target.contentWindow?.postMessage(message, embedOrigin)
}

// A second frame of the embed page shows attachment previews over the whole
// page, since the panel's frame can't draw outside the panel. It loads on the
// first preview and stays loaded, hidden, for the next. It shows only once its
// page is ready, so a page that never loads can't cover the app.
let previewFrame: HTMLIFrameElement | null = null
let previewReady = false
let pendingGallery: Gallery | null = null

function showPreview(gallery: Gallery) {
  if (!previewFrame) {
    const url = new URL(embedUrl!)
    url.searchParams.set(PREVIEW_PARAM, '1')
    previewFrame = document.createElement('iframe')
    previewFrame.className = 'preview'
    previewFrame.title = 'lander attachment preview'
    previewFrame.allow = 'clipboard-write'
    previewFrame.hidden = true
    previewFrame.src = url.href
    root.append(previewFrame)
  }
  if (!previewReady) {
    pendingGallery = gallery
    return
  }
  tellEmbed({ type: 'lander-widget-preview', gallery }, previewFrame)
  previewFrame.hidden = false
  // The preview's keys work only once its frame has focus.
  previewFrame.focus()
}

function hidePreview() {
  if (previewFrame) previewFrame.hidden = true
  frame.focus()
}

// Picking hides the panel without closing it, so the embed keeps its place.
async function pick() {
  if (host.classList.contains('picking')) return
  host.classList.add('picking')
  const element = await pickElement(root, host, onOwnPress)
  host.classList.remove('picking')
  frame.focus()
  if (element) tellEmbed({ type: 'lander-widget-picked', reference: describeElement(element) })
}

// The embed shows the conversation only while the panel is open, and marks
// the task read only while it's also in view.
function reportView() {
  if (!embedReady) return
  const open = !panel.hidden
  const active = open && !document.hidden && document.hasFocus()
  tellEmbed({ type: 'lander-widget-view', open, active })
}

function setOpen(open: boolean) {
  panel.hidden = !open
  toggle.setAttribute('aria-expanded', String(open))
  sessionStorage.setItem(OPEN_KEY, open ? 'true' : '')
  reportView()
}

window.addEventListener('message', (event: MessageEvent<EmbedMessage | undefined>) => {
  if (event.origin !== embedOrigin) return
  const message = event.data
  if (previewFrame && event.source === previewFrame.contentWindow) {
    if (message?.type === 'lander-preview-ready') {
      previewReady = true
      if (pendingGallery) showPreview(pendingGallery)
      pendingGallery = null
    } else if (message?.type === 'lander-preview-closed') hidePreview()
    return
  }
  if (event.source !== frame.contentWindow) return
  if (message?.type === 'lander-embed-preview') showPreview(message.gallery)
  else if (message?.type === 'lander-embed-pick') void pick()
  else if (message?.type === 'lander-embed-ready') {
    embedReady = true
    reportView()
  } else if (message?.type === 'lander-embed-focus') setTimeout(reportView)
  else if (message?.type === 'lander-task-state') {
    toggle.classList.toggle('unread', message.unread === true)
    toggle.classList.toggle('riding', message.riding === true)
  }
})
window.addEventListener('focus', reportView)
// Clicking into the frame blurs this window before focus lands in the frame.
window.addEventListener('blur', () => setTimeout(reportView))
document.addEventListener('visibilitychange', reportView)

onOwnPress(toggle, 'click', () => setOpen(!!panel.hidden))
// Focus stays in the app, so a popup there that closes when it loses focus
// stays open while the user opens the panel.
onOwnPress(toggle, 'mousedown', (event) => event.preventDefault())
// Clicks in the frame land in its own document and never reach this window.
// Listening without cancelling leaves the page's own handling untouched.
window.addEventListener(
  'pointerdown',
  (event) => {
    if (!panel.hidden && !event.composedPath().includes(host)) setOpen(false)
  },
  { capture: true },
)
document.body.append(host)
setOpen(sessionStorage.getItem(OPEN_KEY) === 'true')
