import { buildTimeline, type RideItem, type TimelineEntry } from './timeline'
import { foldSummary, planTurnCollapse, splitNotices } from './turnCollapse'
import type { Item, MessageItem, Ride } from '../src/types'
import { contextLabel, contextSummary, contextDuration } from './context'

// A task's conversation as plain text, the counterpart of the markdown copy for
// readers without a screen — `lander view`, through the server. One block per
// message the task received, hook report, and agent turn. Each agent turn is
// folded as search and the markdown copy fold it, running turns included, with
// tools as one-line chips and subagents' work left out; `expand` opens every
// fold. Lifecycle notes, cross-task actions and asks are not blocks; a message a
// lifecycle event delivered (a ride's notification, a relaunch brief) is. A turn
// with nothing to show yields no block.
export type ConversationBlock = { role: string; text: string; folded?: true }

export function conversationText(
  task: { items?: Item[]; rides?: Ride[] },
  opts: { expand: boolean },
): ConversationBlock[] {
  // `now` only dates a running turn's entry, which no block shows.
  return buildTimeline(task, '').items.flatMap((entry) => {
    const block = entryBlock(entry, opts.expand)
    return block?.text.trim() ? [block] : []
  })
}

export const REPROMPT_LABEL = 'Lander prompted the agent again'

// A tool chip's input rides one line, so a multi-line input (a codex command)
// collapses to spaces exactly as it does in the chip's span.
export function oneLine(s: string): string {
  return s.replace(/\s*\n\s*/g, ' ').trim()
}

function entryBlock(entry: TimelineEntry, expand: boolean): ConversationBlock | null {
  switch (entry.kind) {
    case 'user':
      return messageBlock(entry.item)
    case 'event':
      return entry.message ? messageBlock(entry.message) : null
    case 'hook': {
      const h = entry.hook
      return { role: `hook ${h.hook}`, text: h.text || h.error || `(${h.outcome})` }
    }
    case 'ride':
      return { role: 'assistant', ...rideText(entry.items, expand) }
    default:
      return null
  }
}

function messageBlock(m: MessageItem): ConversationBlock {
  const from = m.from
  const role =
    m.role === 'hook'
      ? `hook ${from && 'hook' in from ? from.hook : ''}`.trim()
      : from && 'task' in from
        ? from.via === 'relaunch'
          ? 'relaunch'
          : `from ${from.task}`
        : from && 'lander' in from
          ? 'notification'
          : 'user'
  return { role, text: m.text }
}

function rideText(rideItems: RideItem[], expand: boolean): { text: string; folded?: true } {
  const { trace: items, notices } = splitNotices(rideItems)
  const segments = planTurnCollapse(items).segments
  const folds = !expand && segments.some((seg) => seg.hidden)
  const text = [
    ...segments.flatMap((seg) =>
      seg.hidden && !expand
        ? [`[${foldSummary(items, seg.indices)}]`]
        : seg.indices.map(itemLine),
    ),
    ...notices.map((it) => it.text.trim()),
  ]
    .filter((line) => line.trim())
    .join('\n\n')
  return folds ? { text, folded: true } : { text }

  function itemLine(j: number): string {
    const it = items[j]
    if (it.kind === 'context')
      return [contextLabel(it.action), contextSummary(it), contextDuration(it)].filter(Boolean).join(' · ')
    if (it.kind === 'reprompt') return `${REPROMPT_LABEL}:\n${it.text.trim()}`
    if (it.kind === 'message') return it.text.trim()
    if (it.kind !== 'tool') return ''
    const input = it.input ? `: ${oneLine(it.input)}` : ''
    const status = it.status === 'blocked' || it.status === 'failed' ? ` (${it.status})` : ''
    return `⚙ ${it.name}${input}${status}`
  }
}
