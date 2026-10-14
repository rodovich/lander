// The conversation as markdown, for the header's copy button: the same stream
// the reader is looking at, in text. It mirrors the renderers rather than the
// stored log — a tool chip whose detail is closed contributes its one-line
// input and nothing else, and a folded stretch of a turn contributes the
// summary the fold shows in its place. What is on screen is what lands on the
// clipboard.
//
// Three disclosures stay closed here whatever the reader did with them: a task
// action's sent message, a message another task sent this one, and a message a
// lifecycle event delivered (a relaunch's brief). Their
// open/closed state lives inside the row's own component rather than in the
// pane's state, so this module can't see it. The collapsed reading is the one a
// freshly-opened task shows.
//
// And one fold applies here that the screen skips: every agent turn collapses,
// a still-running one included, where the view leaves a running turn whole
// while its shape is still changing.

import { formatTimestamp } from './format'
import { EVENT_VERB } from './lifecycleNote'
import { toolDetail } from './toolStep'
import { oneLine } from './conversationText'
import { foldSummary, planTurnCollapse, turnThreads } from './turnCollapse'
import type { TimelineEntry } from './timeline'
import type {
  AskItem,
  Attachment,
  TaskActionItem,
  TaskWithProject,
  ToolItem,
} from './types'

// The longest run of backticks in a string, so a code span or fence can pick a
// delimiter the content can't close.
const longestTickRun = (s: string) =>
  (s.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0)

function inlineCode(s: string): string {
  const ticks = '`'.repeat(longestTickRun(s) + 1)
  // A span whose content starts or ends with a backtick needs a space of
  // padding, which the renderer strips again.
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${s}${pad}${ticks}`
}

function fence(body: string, lang = ''): string {
  const ticks = '`'.repeat(Math.max(3, longestTickRun(body) + 1))
  return `${ticks}${lang}\n${body}\n${ticks}`
}

// A subagent's trace, set apart from its spawner the way the nested chip block
// is on screen.
const blockquote = (block: string) =>
  block
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')

const heading = (role: string, at: string) =>
  `## ${role} · ${formatTimestamp(at)}`

const attachmentLine = (files: Attachment[]) =>
  `_attachments: ${files.map((f) => f.name).join(', ')}_`

// A named task, as the chips name it: its title when there is one, else the id
// that stands in for it.
const refName = (ref: { id: string; title?: string }) => ref.title || ref.id

// What a cross-task action says, matching taskActionNote's wording minus
// the links (a task chip is a name in text).
function actionSentence(item: TaskActionItem): string {
  const target = refName(item.target)
  if (item.action === 'status') {
    return `set task ${target} to ${item.toStatus || '(empty)'}`
  }
  const noun = item.action === 'launch' ? 'task' : 'message to task'
  if (item.trigger?.kind === 'scheduled') {
    const verb = item.action === 'launch' ? 'scheduled task' : 'scheduled a message to task'
    return `${verb} ${target} for ${formatTimestamp(item.trigger.scheduledFor)}`
  }
  if (item.trigger?.kind === 'awaiting') {
    const tasks = item.trigger.tasks
    const cond =
      tasks.length === 1 ? refName(tasks[0]) : `${tasks.length} tasks`
    const or = item.trigger.scheduledFor
      ? ` (or ${formatTimestamp(item.trigger.scheduledFor)})`
      : ''
    return `${noun} ${target} awaiting ${cond}${or}`
  }
  return item.action === 'launch'
    ? `launched task ${target}`
    : `messaged task ${target}`
}

// A lifecycle event's sentence, matching lifecycleNote's.
function eventSentence(
  event: Extract<TimelineEntry, { kind: 'event' }>['event'],
): string {
  const name = event.title ? `${event.title} ` : ''
  if (event.eventKind === 'awaiting') {
    const tasks = event.awaiting ?? []
    const cond =
      tasks.length === 1
        ? ` ${refName(tasks[0])}`
        : ` ${tasks.length} tasks${tasks.length ? ` (${tasks.map(refName).join(', ')})` : ''}`
    return `${name}awaiting${cond}`
  }
  const when =
    (event.eventKind === 'scheduled' || event.eventKind === 'relaunched') &&
    event.scheduledFor
      ? ` ${formatTimestamp(event.scheduledFor)}`
      : ''
  return `${name}${EVENT_VERB[event.eventKind]}${when}`
}

// An ask's prompt and the choices it offers, with the one that was taken marked.
function askBlocks(ask: AskItem): string[] {
  const blocks: string[] = []
  if (ask.prompt?.trim()) blocks.push(ask.prompt.trim())
  const options = ask.form?.options ?? []
  if (options.length)
    blocks.push(
      options
        .map(
          (o) =>
            `- ${o.label}${o.detail ? ` — ${o.detail}` : ''}${
              ask.answer?.optionId === o.id ? ' _(answered)_' : ''
            }`,
        )
        .join('\n'),
    )
  if (ask.answer?.text?.trim()) blocks.push(`_answered:_ ${ask.answer.text.trim()}`)
  return blocks
}

export function conversationMarkdown({
  task,
  timeline,
  openDetails,
  expandedTurns,
}: {
  task: TaskWithProject
  timeline: TimelineEntry[]
  // The tool items whose detail the reader has revealed, and the fold keys
  // (`${rideId}:${segmentIndex}`) they have expanded — the pane's own state.
  openDetails: Set<string>
  expandedTurns: Set<string>
}): string {
  // The open ask hangs off the turn that raised it, as that turn's footer.
  const openAsk = task.items?.find(
    (it): it is AskItem => it.kind === 'ask' && it.state === 'open',
  )

  const blocks: string[] = [`# ${task.title}`]

  for (const entry of timeline) {
    if (entry.kind === 'user') {
      const m = entry.item
      if (m.from && 'task' in m.from) {
        blocks.push(`_received message from ${m.from.task}_ · ${formatTimestamp(m.at)}`)
        continue
      }
      const role =
        m.role === 'hook'
          ? `hook ${m.from && 'hook' in m.from ? m.from.hook : ''}`.trim()
          : 'you'
      blocks.push(heading(role, m.at))
      if (m.text.trim()) blocks.push(m.text.trim())
      if (m.attachments?.length) blocks.push(attachmentLine(m.attachments))
      continue
    }
    if (entry.kind === 'event') {
      blocks.push(`_${eventSentence(entry.event)}_ · ${formatTimestamp(entry.at)}`)
      continue
    }
    if (entry.kind === 'task-action') {
      blocks.push(
        `_${actionSentence(entry.action)}_ · ${formatTimestamp(entry.at)}`,
      )
      continue
    }
    if (entry.kind === 'ask') {
      blocks.push(heading('lander', entry.ask.at), ...askBlocks(entry.ask))
      continue
    }
    if (entry.kind === 'hook') {
      const h = entry.hook
      blocks.push(heading(`hook ${h.hook}`, h.at))
      if (h.text?.trim()) blocks.push(h.text.trim())
      if (h.error) blocks.push(fence(h.error))
      if (h.output) blocks.push(fence(h.output))
      continue
    }
    blocks.push(...rideBlocks(entry, openDetails, expandedTurns))
    if (openAsk?.rideId === entry.ride.id) blocks.push(...askBlocks(openAsk))
  }

  return blocks.join('\n\n') + '\n'
}

// One assistant turn: its heading, then the trace as the turn renders it —
// prose, tool chips with whatever detail is open, and a summary line standing
// for each folded stretch.
function rideBlocks(
  entry: Extract<TimelineEntry, { kind: 'ride' }>,
  openDetails: Set<string>,
  expandedTurns: Set<string>,
): string[] {
  const items = entry.items
  const { childrenByParent } = turnThreads(items)

  const renderIdxs = (idxs: number[]): string[] =>
    idxs.flatMap((j) => itemBlocks(j))

  const itemBlocks = (j: number): string[] => {
    const it = items[j]
    if (it.kind === 'message') return it.text.trim() ? [it.text.trim()] : []
    if (it.kind !== 'tool') return []
    return toolBlocks(it, childrenByParent.get(it.id) ?? [])
  }

  const toolBlocks = (it: ToolItem, childIdxs: number[]): string[] => {
    const { hasDiff, hasChildren, hasResult, hasDetail } = toolDetail(
      it,
      childIdxs.length > 0,
    )
    const open = hasDetail && openDetails.has(it.id)
    const status =
      it.status === 'blocked' || it.status === 'failed' ? ` _(${it.status})_` : ''
    // Closed, the chip carries its one-line input; open, that copy moves into
    // the body below and the head is just the tool's name.
    const head =
      `**${it.name}**` +
      (it.input && !open ? ` ${inlineCode(oneLine(it.input))}` : '') +
      status
    if (!open) return [head]

    const out = [head]
    if (it.input) out.push(fence(it.inputFull ?? it.input))
    if (hasDiff)
      out.push(
        fence(
          it
            .edits!.map((e) =>
              [
                ...diffLines(e.old).map((l) => `- ${l}`),
                ...diffLines(e.new).map((l) => `+ ${l}`),
              ].join('\n'),
            )
            .join('\n'),
          'diff',
        ),
      )
    if (hasChildren) out.push(blockquote(renderIdxs(childIdxs).join('\n\n')))
    if (hasResult) out.push(fence(it.output!))
    return out
  }

  const body = planTurnCollapse(items).segments.flatMap((seg, si) =>
    !seg.hidden || expandedTurns.has(`${entry.ride.id}:${si}`)
      ? renderIdxs(seg.indices)
      : [`_${foldSummary(items, seg.indices)}_`],
  )

  const files = items.flatMap((it) =>
    it.kind === 'message' ? (it.attachments ?? []) : [],
  )
  return [
    heading('agent', entry.ride.startedAt),
    ...body,
    ...(files.length ? [attachmentLine(files)] : []),
  ]
}

// The lines a diff side contributes, dropping the trailing empty one a string
// ending in a newline would otherwise add (as DiffView does).
function diffLines(s: string): string[] {
  if (s === '') return []
  const parts = s.split('\n')
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  return parts
}
