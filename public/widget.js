// The lander widget. An app's page loads this as a classic script, so it needs
// no CORS from lander, with its task's embed page in `data-embed-url`.
;(() => {
  const embedUrl = document.currentScript.dataset.embedUrl
  if (!embedUrl) throw new Error('lander widget: the script tag has no data-embed-url')

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
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        font: 13px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
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
        padding: 6px 12px;
        border: 1px solid rgba(17, 0, 0, 0.12);
        border-radius: 999px;
        background: #fcfaf8;
        color: rgba(17, 0, 0, 0.85);
        font: inherit;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(17, 0, 0, 0.16);
      }
    </style>
    <div class="panel" hidden></div>
    <button type="button" class="toggle" aria-expanded="false">lander</button>
  `
  const panel = root.querySelector('.panel')
  const toggle = root.querySelector('.toggle')

  // The frame is made on first open and kept while closed, so closing and
  // reopening doesn't reload the conversation.
  function setOpen(open) {
    if (open && !panel.firstChild) {
      const frame = document.createElement('iframe')
      frame.title = 'lander task'
      frame.src = embedUrl
      panel.append(frame)
    }
    panel.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    sessionStorage.setItem(OPEN_KEY, open ? 'true' : '')
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden))
  document.body.append(host)
  setOpen(sessionStorage.getItem(OPEN_KEY) === 'true')
})()
