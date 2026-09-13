import { memo } from 'react'
import { AskForm } from './asks'
import { MessageAttachments } from './attachments'
import { formatTimestamp } from './format'
import { BlockedSummary } from './grants'
import type { TaskLinkResolver } from './markdown'
import { blockedRequests } from './permissions'
import { taskAgentModelName } from './taskMeta'
import { TurnTrace } from './turnTrace'
import type { RideItem } from './timeline'
import type { AskItem, Ride, TaskActionItem, Task } from './types'
import type { TimelineDisclosure } from './useTimelineDisclosure'

// One assistant turn in the conversation: the bubble around a turn's trace (see
// TurnTrace), carrying the turn's confirmed denials, the in-flight working
// spinner, the files it attached, and — when this turn raised the open ask —
// the ask's form as the turn's footer.
export const RideTurn = memo(function RideTurn({
  ride,
  items,
  actions,
  agent,
  slug,
  grants,
  linkTask,
  disclosure,
  openAsk,
  answering,
  onAnswerAsk,
  onAllow,
}: {
  ride: Ride
  items: RideItem[]
  // What this turn did to other tasks, in record order.
  actions: TaskActionItem[]
  // The flow name (task.flow ?? task.agent), for display only.
  agent: string | undefined
  slug: string
  grants: Task['grants']
  linkTask: TaskLinkResolver
  disclosure: TimelineDisclosure
  // The task's open ask; rendered as this turn's footer only when this ride
  // raised it.
  openAsk: AskItem | undefined
  answering: boolean
  onAnswerAsk: (askId: string, body: { optionId?: string; text?: string }) => void
  onAllow: (rule: string, scope: 'task' | 'project') => Promise<boolean>
}) {
  const settled = !!ride.endedAt
  // A finished turn's confirmed denials. Denials are authoritative at ride end,
  // so an open ride shows none, and a task whose agent never reports them
  // (codex) simply has no line.
  const denied = settled ? blockedRequests(items) : []
  // Files the turn produced, gathered from its flow items.
  const files = items.flatMap((it) =>
    it.kind === 'message' ? (it.attachments ?? []) : [],
  )
  return (
    <div className="message message-assistant">
      <div className="message-head">
        <span className="message-role">assistant</span>
        <span className="message-time">{formatTimestamp(ride.startedAt)}</span>
      </div>
      <div className="steps">
        <TurnTrace
          items={items}
          actions={actions}
          rideId={ride.id}
          settled={settled}
          linkTask={linkTask}
          disclosure={disclosure}
        />
      </div>
      {denied.length > 0 && (
        <BlockedSummary requests={denied} grants={grants} onAllow={onAllow} />
      )}
      {/* The in-flight turn's working spinner, after the ride's last item — an
          open ride (no endedAt) is streaming. */}
      {!settled && (
        <div className="message-pending">
          <span className="spinner" aria-hidden />
          {`${taskAgentModelName(agent, ride.usage?.model)} is working…`}
        </div>
      )}
      {files.length > 0 && (
        <MessageAttachments attachments={files} slug={slug} />
      )}
      {/* The open ask's controls hang off the turn that raised it, as its
          footer — at the very bottom of the bubble, below any prose the agent
          wrote before or after wedging. */}
      {openAsk && openAsk.rideId === ride.id && (
        <AskForm
          ask={openAsk}
          linkTask={linkTask}
          disabled={answering}
          onAnswer={(body) => onAnswerAsk(openAsk.id, body)}
        />
      )}
    </div>
  )
})
