import { memo, type ReactNode } from 'react'
import { AskForm } from './asks'
import { MessageAttachments } from './attachments'
import { formatTimestamp } from './format'
import { BlockedSummary } from './grants'
import { blockedRequests } from './permissions'
import { splitNotices } from '../shared/turnCollapse'
import { taskAgentModelName } from './taskMeta'
import { TurnTrace } from './turnTrace'
import type { RideItem } from '../shared/timeline'
import type { AskItem, FlowCaps, Ride, TaskActionItem, Task } from './types'
import type { TimelineDisclosure } from './useTimelineDisclosure'

// The riding task's spinner row — "working…" in its open turn, "starting…"
// before the turn has streamed anything, or "waiting…" once the agent's turn has
// ended but its background work keeps the run open — with a Pace button that interrupts
// the turn, the same as the kebab menu's Pace.
export function PendingRow({
  onPace,
  children,
}: {
  onPace: () => void
  children: ReactNode
}) {
  return (
    <div className="message-pending">
      <span className="spinner" aria-hidden />
      {children}
      <button
        className="pending-pace"
        title="Interrupt this turn and leave the task paced"
        onClick={onPace}
      >
        Pace
      </button>
    </div>
  )
}

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
  disclosure,
  openAsk,
  answering,
  onAnswerAsk,
  onAllow,
  onPace,
  onRetry,
}: {
  ride: Ride
  items: RideItem[]
  // What this turn did to other tasks, in record order.
  actions: TaskActionItem[]
  // The name of the flow the ride was for, for display only.
  agent: string | undefined
  slug: string
  grants: FlowCaps['grants']
  disclosure: TimelineDisclosure
  // The task's open ask; rendered as this turn's footer only when this ride
  // raised it.
  openAsk: AskItem | undefined
  answering: boolean
  onAnswerAsk: (askId: string, body: { optionId?: string; text?: string }) => void
  onAllow: (rule: string, scope: 'task' | 'project') => Promise<boolean>
  // Paces the task, from the open turn's spinner row.
  onPace: () => void
  onRetry?: () => Promise<boolean>
}) {
  const settled = !!ride.endedAt
  const { trace, notices } = splitNotices(items)
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
        <span className="message-role">agent</span>
        <span className="message-time">{formatTimestamp(ride.startedAt)}</span>
      </div>
      <div className="steps">
        <TurnTrace
          items={trace}
          actions={actions}
          rideId={ride.id}
          settled={settled}
          disclosure={disclosure}
        />
      </div>
      {denied.length > 0 && (
        <BlockedSummary requests={denied} grants={grants} onAllow={onAllow} onRetry={onRetry} />
      )}
      {notices.map((it) => (
        <div key={it.id} className="turn-notice">
          {it.text}
        </div>
      ))}
      {/* The in-flight turn's working spinner, after the ride's last item — an
          open ride (no endedAt) is streaming. */}
      {!settled && (
        <PendingRow onPace={onPace}>
          {ride.compacting
            ? 'Compacting context…'
            : ride.waiting
              ? 'Waiting for background work…'
              : `${taskAgentModelName(agent, ride.usage?.model)} is working…`}
        </PendingRow>
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
          disabled={answering}
          onAnswer={(body) => onAnswerAsk(openAsk.id, body)}
        />
      )}
    </div>
  )
})
