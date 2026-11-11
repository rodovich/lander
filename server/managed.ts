import { openRide } from '../shared/timeline'
import type { Attachment } from './attachments'
import {
  hasOwnScheduledRide,
  hasPendingTrigger,
  lastFlowItem,
  NOTIFY_TEXT_MAX_CHARS,
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
  const shown =
    text.length > NOTIFY_TEXT_MAX_CHARS
      ? `${text.slice(0, NOTIFY_TEXT_MAX_CHARS)}… (\`lander view ${child.id}\` shows the rest.)`
      : text
  return ride.outcome === 'done' ? shown : `(This turn was cut short: ${ride.outcome}.)\n${shown}`
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
  const attachments: Attachment[] = []
  const seen: Record<string, string> = {}
  for (const child of children) {
    const rides = unseenRides(parent, child)
    const last = rides.at(-1)
    if (!last) continue
    const kept = rides.filter((r) => r === last || startedByParent(parent, child, r))
    const omitted = rides.length - kept.length
    const parts = kept.map((r) => rideText(child, r))
    if (omitted)
      parts.splice(
        -1,
        0,
        `(${omitted} other ${omitted === 1 ? 'turn' : 'turns'} not shown; \`lander view ${child.id} --messages all\` has them.)`,
      )
    sections.push(
      `${child.id} [${publicTaskStatus(child)}]:\n${parts.join('\n\n')}`,
    )
    attachments.push(...kept.flatMap((r) => rideAttachments(child, r.id)))
    seen[child.id] = last.endedAt
  }
  if (!sections.length) return undefined
  return {
    text: `Results from tasks you manage that you have not read:\n\n${sections.join('\n\n')}`,
    attachments,
    seen,
  }
}
