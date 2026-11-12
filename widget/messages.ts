// The widget and the embed page in its frame talk only through these messages.

export type WidgetMessage = { type: 'lander-widget-view'; open: boolean; active: boolean }

export type EmbedMessage =
  | { type: 'lander-embed-ready' }
  | { type: 'lander-embed-focus' }
  | { type: 'lander-task-state'; unread: boolean; riding: boolean }
