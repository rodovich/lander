// The lander widget, which runs only as the classic script the web server
// bundles at /widget.js: `document.currentScript` is null in a module.
import type { EmbedMessage, WidgetMessage } from './messages'
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

function tellEmbed(message: WidgetMessage) {
  frame.contentWindow?.postMessage(message, embedOrigin)
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
  if (event.source !== frame.contentWindow || event.origin !== embedOrigin) return
  const message = event.data
  if (message?.type === 'lander-embed-ready') {
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

toggle.addEventListener('click', () => setOpen(!!panel.hidden))
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
