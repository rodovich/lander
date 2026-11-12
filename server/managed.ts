import { conversationEntries } from '../shared/conversationText'
import { entryMessage, entryRide, openRide, type TimelineEntry } from '../shared/timeline'
import type { Attachment } from './attachments'
import {
  hasOwnScheduledRide,
  hasPendingTrigger,
  lastFlowItem,
  publicTaskStatus,
  rideAttachments,
  userItems,
  type Item,
  type PendingTriggers,
  type Ride,
} from './tasks'

// Delivering a managed child's results to the task that launched it. Computed
// from current state on each pass, because a parent's turn ending and a child's
// ride ending are writes to two files and can land in either order.

export type FamilyTask = PendingTriggers & {
  id: string
  status: string
  runId?: string
  queued?: string[]
  pendingNotify?: unknown
  rides?: Ride[]
  items?: Item[]
  childrenSeen?: Record<string, string>
}

export type Family = {
  tasks: Map<string, FamilyTask>
  childrenOf: (id: string) => string[]
  // Held by a live drive, which a task's own record can't show.
  driving: (id: string) => boolean
  // Tasks with an answer on the way to their `send --await`.
  awaitingAnswer: Set<string>
}

function closedRides(task: FamilyTask): (Ride & { endedAt: string })[] {
  return (task.rides ?? []).filter((r): r is Ride & { endedAt: string } => !!r.endedAt)
}

function unseenRides(parent: FamilyTask, child: FamilyTask) {
  const seen = parent.childrenSeen?.[child.id] ?? ''
  return closedRides(child).filter((r) => r.endedAt > seen)
}

function deliveredTo(child: FamilyTask, ride: Ride) {
  return userItems(child).filter((i) => i.deliveredIn === ride.id)
}

// A ride left with no message of its own, because a restart resumed it or a retry
// took its message away, is attributed to the ride before it. A best guess: the
// record doesn't say who it was for.
function startedOnlyByUser(child: FamilyTask, ride: Ride): boolean {
  const senders = deliveredTo(child, ride).filter(
    (i) => !(i.from && 'lander' in i.from && i.from.lander === 'restart'),
  )
  if (senders.length) return senders.every((i) => !i.from)
  const rides = child.rides ?? []
  const previous = rides[rides.indexOf(ride) - 1]
  return !!previous && startedOnlyByUser(child, previous)
}

function startedByParent(parent: FamilyTask, child: FamilyTask, ride: Ride): boolean {
  return deliveredTo(child, ride).some(
    (i) => i.from && 'task' in i.from && i.from.task === parent.id && i.from.via !== 'notify',
  )
}

function hasWakingActivity(parent: FamilyTask, child: FamilyTask): boolean {
  return unseenRides(parent, child).some((r) => !startedOnlyByUser(child, r))
}

function idle(task: FamilyTask, family: Family): boolean {
  return !family.driving(task.id) && !task.runId && !openRide(task)
}

// A deferred launch or a wedged task's deferred retry holds its queue back on
// purpose; only a queue about to be driven means more work is coming.
function queuedToRun(task: FamilyTask): boolean {
  if (task.status === 'landed' || !task.queued?.length) return false
  return !(hasPendingTrigger(task) && !hasOwnScheduledRide(task))
}

export function settled(id: string, family: Family): boolean {
  const task = family.tasks.get(id)
  if (!task) return true
  if (!idle(task, family) || queuedToRun(task) || task.pendingNotify) return false
  if (family.awaitingAnswer.has(id)) return false
  return family.childrenOf(id).every((childId) => {
    const child = family.tasks.get(childId)
    return settled(childId, family) && !(child && hasWakingActivity(task, child))
  })
}

export function wakeDue(parentId: string, family: Family): boolean {
  const parent = family.tasks.get(parentId)
  if (!parent || parent.status !== 'riding') return false
  if (!idle(parent, family) || parent.queued?.length) return false
  // Children the parent is already waiting to see land are its own plan.
  const children = family
    .childrenOf(parentId)
    .filter((id) => !parent.waitingFor?.includes(id))
  const waking = children.some((id) => {
    const child = family.tasks.get(id)
    return child && hasWakingActivity(parent, child)
  })
  return waking && children.every((id) => settled(id, family))
}

function rideText(child: FamilyTask, ride: Ride): string {
  const text = lastFlowItem(child, ride.id)?.text?.trim()
  if (!text) return `(This turn ended without a reply: ${ride.outcome ?? 'unknown'}.)`
  return ride.outcome === 'done' ? text : `(This turn was cut short: ${ride.outcome}.)\n${text}`
}

// Past this many characters of replies, the parent gets a count of each child's
// unread messages instead of the replies, and reads what it needs with
// `lander view`.
export const CHILD_RESULTS_MAX_CHARS = 6000

function fromParent(parent: FamilyTask, entry: TimelineEntry): boolean {
  const from = entryMessage(entry)?.from
  return !!from && 'task' in from && from.task === parent.id
}

// The messages `lander view` shows from the first one the parent hasn't seen,
// not counting the parent's own messages that start them: it wrote those, and a
// launch brief can be far longer than the reply.
function unreadMessages(parent: FamilyTask, child: FamilyTask, rides: Ride[]) {
  const unseen = new Set(rides.map((r) => r.id))
  const seen = parent.childrenSeen?.[child.id] ?? ''
  const entries = conversationEntries(child, { expand: false })
  const first = entries.findIndex(({ entry }) => {
    if (fromParent(parent, entry)) return false
    const ride = entryRide(entry)
    return ride ? unseen.has(ride) : entry.at > seen
  })
  const unread = first < 0 ? [] : entries.slice(first)
  return {
    count: unread.length,
    chars: unread.reduce((n, { block }) => n + block.text.length, 0),
  }
}

function childHeader(child: FamilyTask): string {
  return `${child.id} [${publicTaskStatus(child)}]:`
}

function countLine(parent: FamilyTask, child: FamilyTask, rides: Ride[]): string {
  const { count, chars } = unreadMessages(parent, child, rides)
  return `${childHeader(child)} ${count} ${count === 1 ? 'message' : 'messages'}, ${chars.toLocaleString('en-US')} characters`
}

export type ChildResults = {
  text: string
  attachments: Attachment[]
  seen: Record<string, string>
}

export function childResults(
  parent: FamilyTask,
  children: FamilyTask[],
): ChildResults | undefined {
  const sections: string[] = []
  const unread: [FamilyTask, Ride[]][] = []
  const attachments: Attachment[] = []
  const seen: Record<string, string> = {}
  for (const child of children) {
    const rides = unseenRides(parent, child)
    const last = rides.at(-1)
    if (!last) continue
    unread.push([child, rides])
    const kept = rides.filter((r) => r === last || startedByParent(parent, child, r))
    const omitted = rides.length - kept.length
    const parts = kept.map((r) => rideText(child, r))
    if (omitted)
      parts.splice(
        -1,
        0,
        `(${omitted} other ${omitted === 1 ? 'turn' : 'turns'} not shown; \`lander view ${child.id} --messages all\` has them.)`,
      )
    sections.push(`${childHeader(child)}\n${parts.join('\n\n')}`)
    attachments.push(...kept.flatMap((r) => rideAttachments(child, r.id)))
    seen[child.id] = last.endedAt
  }
  if (!sections.length) return undefined
  const replies = sections.join('\n\n')
  const text =
    replies.length > CHILD_RESULTS_MAX_CHARS
      ? `Tasks you manage have messages you have not read. \`lander view <id> --messages <N>\` shows a task's last N messages.\n\n${unread.map(([child, rides]) => countLine(parent, child, rides)).join('\n')}`
      : `Results from tasks you manage that you have not read:\n\n${replies}`
  return { text, attachments, seen }
}
