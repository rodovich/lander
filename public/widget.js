// The lander widget. An app's page loads this as a classic script, so it needs
// no CORS from lander, with its task's embed page in `data-embed-url`.
;(() => {
  const script = document.currentScript
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
    <style>
      :host {
        all: initial;
        position: fixed;
        left: 16px;
        bottom: 16px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 8px;
        font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        --riding: #6644ee;
      }
      .panel {
        width: min(420px, calc(100vw - 32px));
        height: min(600px, calc(100vh - 72px));
        border: 1px solid rgba(17, 0, 0, 0.12);
        border-radius: 8px;
        overflow: hidden;
        background: #fcfaf8;
        box-shadow: 0 8px 24px rgba(17, 0, 0, 0.16);
      }
      .panel[hidden] {
        display: none;
      }
      iframe {
        display: block;
        width: 100%;
        height: 100%;
        border: 0;
      }
      .toggle {
        position: relative;
        display: flex;
        padding: 8px;
        border: 1px solid rgba(17, 0, 0, 0.12);
        border-radius: 50%;
        background: #fcfaf8;
        color: rgba(17, 0, 0, 0.85);
        font: inherit;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(17, 0, 0, 0.16);
      }
      .toggle img {
        width: 20px;
        height: 20px;
      }
      /* lander's riding color: a ring while the task is unread, and a turning
         arc, like lander's spinners, while it rides. */
      .toggle::after {
        content: '';
        position: absolute;
        inset: -3px;
        border: 2px solid transparent;
        border-radius: 50%;
        pointer-events: none;
      }
      .toggle.unread::after {
        border-color: var(--riding);
      }
      .toggle.riding::after {
        border-color: transparent;
        border-top-color: var(--riding);
        animation: lander-spin 0.7s linear infinite;
      }
      @keyframes lander-spin {
        to {
          transform: rotate(360deg);
        }
      }
    </style>
    <div class="panel" hidden></div>
    <button type="button" class="toggle" aria-label="lander" aria-expanded="false">
      <img alt="" src="${iconUrl}" />
    </button>
  `
  const panel = root.querySelector('.panel')
  const toggle = root.querySelector('.toggle')

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

  // The embed shows the conversation only while the panel is open, and marks
  // the task read only while it's also in view.
  function reportView() {
    if (!embedReady) return
    const open = !panel.hidden
    const active = open && !document.hidden && document.hasFocus()
    frame.contentWindow.postMessage({ type: 'lander-widget-view', open, active }, embedOrigin)
  }

  function setOpen(open) {
    panel.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    sessionStorage.setItem(OPEN_KEY, open ? 'true' : '')
    reportView()
  }

  window.addEventListener('message', (event) => {
    if (event.source !== frame.contentWindow || event.origin !== embedOrigin) return
    if (event.data?.type === 'lander-embed-ready') {
      embedReady = true
      reportView()
    } else if (event.data?.type === 'lander-embed-focus') setTimeout(reportView)
    else if (event.data?.type === 'lander-task-state') {
      toggle.classList.toggle('unread', event.data.unread === true)
      toggle.classList.toggle('riding', event.data.riding === true)
    }
  })
  window.addEventListener('focus', reportView)
  // Clicking into the frame blurs this window before focus lands in the frame.
  window.addEventListener('blur', () => setTimeout(reportView))
  document.addEventListener('visibilitychange', reportView)

  toggle.addEventListener('click', () => setOpen(panel.hidden))
  document.body.append(host)
  setOpen(sessionStorage.getItem(OPEN_KEY) === 'true')
})()
