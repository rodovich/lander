export type OnOwnPress = <K extends keyof WindowEventMap>(
  element: Element,
  type: K,
  handler: (event: WindowEventMap[K]) => void,
) => void

const PRESSES = ['pointerdown', 'mousedown', 'touchstart']
const RELEASES = ['pointerup', 'mouseup', 'touchend', 'click', 'auxclick', 'dblclick', 'contextmenu']

// Keeps presses on the widget's own UI, and the releases and clicks that end
// them, from the app's page, whose "click outside" handlers would otherwise
// close its popups. Listening on the window in the capture phase from the
// moment the widget loads, which is usually before the app's bundle runs,
// puts this ahead of the app's own listeners. Since the events then never
// reach the widget's elements either, the widget handles them through the
// returned `onOwnPress` instead of its own listeners.
export function keepOwnPresses(host: Element): OnOwnPress {
  const handlers = new WeakMap<EventTarget, Map<string, (event: Event) => void>>()
  let pressedOwn = false

  function guard(event: Event) {
    if (!event.isTrusted) return
    const path = event.composedPath()
    const own = path.includes(host)
    if (PRESSES.includes(event.type)) pressedOwn = own
    // A release goes with its press, so a drag from the app that ends over the
    // widget still ends in the app. A click from the keyboard ends no press.
    const fromKeyboard = event.type === 'click' && (event as MouseEvent).detail === 0
    const kept = PRESSES.includes(event.type) || fromKeyboard ? own : pressedOwn
    if (!kept) return
    event.stopImmediatePropagation()
    for (const node of path) handlers.get(node)?.get(event.type)?.(event)
  }

  for (const type of [...PRESSES, ...RELEASES]) window.addEventListener(type, guard, true)
  // The window sees no press inside a frame, and the context menu key fires a
  // release-like event with no press at all. Either would otherwise leave the
  // next release judged by an earlier press on the widget.
  const forgetPress = () => (pressedOwn = false)
  window.addEventListener('keydown', forgetPress, true)
  window.addEventListener('blur', forgetPress)

  return (element, type, handler) => {
    if (!handlers.has(element)) handlers.set(element, new Map())
    handlers.get(element)!.set(type, handler as (event: Event) => void)
  }
}
