// The widget and the embed pages in its frames talk only through these
// messages: the panel's frame holds the conversation, and the preview frame
// shows an attachment over the whole page.
import type { Gallery } from '../src/attachments'

// The query parameter that makes an embed page the preview frame's.
export const PREVIEW_PARAM = 'preview'

export type WidgetMessage =
  | { type: 'lander-widget-view'; open: boolean; active: boolean }
  | { type: 'lander-widget-preview'; gallery: Gallery }

export type EmbedMessage =
  | { type: 'lander-embed-ready' }
  | { type: 'lander-embed-focus' }
  | { type: 'lander-task-state'; unread: boolean; riding: boolean }
  | { type: 'lander-embed-preview'; gallery: Gallery }
  | { type: 'lander-preview-ready' }
  | { type: 'lander-preview-closed' }
