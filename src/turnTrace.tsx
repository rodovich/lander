import { Fragment } from 'react'
import { Collapsible } from './collapsible'
import { MessageText } from './messageText'
import { ContextNote } from './contextNote'
import { RepromptNote } from './repromptNote'
import { TaskActionNote } from './taskActionNote'
import { ToolStep, toolDetail } from './toolStep'
import { planTurnActions } from './turnActions'
import {
  foldSummary,
  groupInferences,
  planTurnCollapse,
  turnThreads,
} from '../shared/turnCollapse'
import type { RideItem } from '../shared/timeline'
import type { TaskActionItem } from './types'
import type { TimelineDisclosure } from './useTimelineDisclosure'

// The cross-task actions anchored at one point in the trace, as one block. They
// stack unruled: what a turn did to other tasks in one stretch of work reads as
// a single aside, not as a row per action.
function TurnActions({ actions }: { actions: TaskActionItem[] }) {
  return (
    <div className="turn-notes">
      {actions.map((action) => (
        <TaskActionNote key={`ta-${action.id}`} item={action} inTurn />
      ))}
    </div>
  )
}

// What one assistant turn did, as the reader sees it: nested tool chips and
// prose grouped by inference, with settled turns folded down
// (planTurnCollapse) and the cross-task actions the turn took anchored into
// that trace (planTurnActions). The bubble around it — the head, the denials,
// the spinner, the ask — is RideTurn's; everything here is the trace itself.
export function TurnTrace({
  items,
  actions,
  rideId,
  settled,
  disclosure: { openDetails, toggleDetail, expandedTurns, toggleTurn },
}: {
  items: RideItem[]
  // What this turn did to other tasks, in record order. Anchored into the trace
  // rather than folded into `items`, so the collapse plan and the tool counts
  // keep describing only what the turn itself streamed.
  actions: TaskActionItem[]
  // Namespaces the fold keys, which are `${rideId}:${segmentIndex}`.
  rideId: string
  // Whether the ride has ended. An open ride renders in full: its shape isn't
  // settled yet, so there is nothing to fold down.
  settled: boolean
  disclosure: TimelineDisclosure
}) {
  // Subagent items don't render inline — they fold into their spawning tool
  // chip, and rendering a child recurses on its own children in turn.
  const { mainIdxs, childrenByParent } = turnThreads(items)
  // Ids of every tool chip with revealable detail in this ride, so an
  // option/shift-click on one toggles them all together — nested chips
  // included, since ids are ride-wide.
  const detailKeys = items.flatMap((it) =>
    it.kind === 'tool' && toolDetail(it, childrenByParent.has(it.id)).hasDetail
      ? [it.id]
      : [],
  )
  // Group consecutive main items by the groupId that produced them (see
  // groupInferences). Each group is one inference — ruled apart from the next.
  const groupByGroup = (idxs: number[]) => groupInferences(items, idxs)
  // Settled turns fold down by their flow messages, independent of group
  // boundaries: keep the opening prose before the first tool, the longest text
  // sequence, and the last, collapsing the ranges between (see
  // planTurnCollapse). An open ride renders in full — its shape isn't settled,
  // and the plan's hidden ranges would shift as prose streams in — as does any
  // turn too short to have a gap.
  const collapse = settled ? planTurnCollapse(items) : null
  // Where this turn's cross-task actions land: each before the next prose
  // section the fold keeps, so a note whose `lander launch` is inside a folded
  // stretch surfaces under that stretch's summary instead of hiding behind it.
  // An unfolded turn anchors against every section.
  const anchored = planTurnActions(
    items,
    mainIdxs,
    actions,
    collapse ?? { segments: [] },
  )

  const renderBody = (j: number) => {
    const it = items[j]
    if (it.kind === 'context') return <ContextNote key={it.id} item={it} />
    if (it.kind === 'reprompt') return <RepromptNote key={it.id} item={it} />
    if (it.kind === 'tool') {
      // A subagent spawner (Agent/Explore) carries its subagent's items as
      // children; render them as the chip's nested trace. renderItem recurses,
      // so a sub-subagent's own chips nest in turn.
      const childIdxs = childrenByParent.get(it.id)
      const subItems = childIdxs?.length ? renderSubItems(childIdxs) : undefined
      return (
        <ToolStep
          key={it.id}
          item={it}
          detailOpen={openDetails.has(it.id)}
          onToggleDetail={(all) =>
            toggleDetail(it.id, all ? detailKeys : [it.id])
          }
          subItems={subItems}
        />
      )
    }
    if (it.kind === 'message') {
      // A flow message item: its prose. The open ask renders as the whole
      // turn's footer, not inline with whatever prose happened to precede the
      // wedge.
      return <MessageText key={it.id} text={it.text} itemId={it.id} />
    }
    return null
  }
  // An item, preceded by whatever this turn did to other tasks in the stretch
  // of work that led to it. `posInGroup` comes from the map below: a note
  // anchored on the group's opening item is hoisted out and ruled off above the
  // group instead of rendering here. Prose opens an inference, so an anchor
  // deeper in a group is the rare case — the branch exists so an out-of-order
  // trace still places its note against the item it belongs to.
  const renderItem = (j: number, posInGroup: number) => {
    const notes = posInGroup > 0 ? anchored.before.get(j) : undefined
    if (!notes) return renderBody(j)
    return (
      <Fragment key={`anchored-${j}`}>
        <TurnActions actions={notes} />
        {renderBody(j)}
      </Fragment>
    )
  }
  const renderItemList = (idxs: number[], keyPrefix = 'items') =>
    groupByGroup(idxs).map((groupIdxs, k) => {
      // What the turn did to other tasks before this inference: its own block,
      // above the inference and ruled off from it, because it is an aside about
      // elsewhere rather than a step of the thinking that follows.
      const lead = anchored.before.get(groupIdxs[0])
      return (
        <Fragment key={`${keyPrefix}-${k}-${groupIdxs[0] ?? 'empty'}`}>
          {k > 0 && <hr className="turn-sep" />}
          {lead && (
            <>
              <TurnActions actions={lead} />
              <hr className="turn-sep" />
            </>
          )}
          <div className="inference">{groupIdxs.map(renderItem)}</div>
        </Fragment>
      )
    })
  // A subagent's folded trace, grouped into its own turns the same way the main
  // thread is. Mutually recursive with renderItem (a nested subagent nests in
  // turn).
  const renderSubItems = (childIdxs: number[]) =>
    renderItemList(childIdxs, `sub-${childIdxs[0] ?? 'empty'}`)
  // Actions with no prose left to precede close the trace out — the same slot
  // they occupied when these stood below the whole turn, and ruled off from it
  // the same way a lead block is. The rule needs something above it, which a
  // turn whose every item is nested under a subagent chip doesn't have.
  const tail = anchored.tail.length > 0 && (
    <>
      {mainIdxs.length > 0 && <hr className="turn-sep" />}
      <TurnActions actions={anchored.tail} />
    </>
  )
  if (!collapse?.segments.some((seg) => seg.hidden))
    return (
      <>
        {renderItemList(mainIdxs)}
        {tail}
      </>
    )
  return (
    <>
      {collapse.segments.map((seg, si) => {
        const sep = si > 0 && <hr className="turn-sep" />
        if (!seg.hidden)
          return (
            <Fragment key={`seg-${si}`}>
              {sep}
              {renderItemList(seg.indices, `seg-${si}`)}
            </Fragment>
          )
        // Each hidden segment folds independently, keyed by ride + segment index.
        const segKey = `${rideId}:${si}`
        const open = expandedTurns.has(segKey)
        return (
          <Fragment key={`seg-${si}`}>
            {sep}
            <Collapsible
              open={open}
              onToggle={() => toggleTurn(segKey)}
              label={
                <span className="collapsible-label">
                  {foldSummary(items, seg.indices)}
                </span>
              }
            >
              {renderItemList(seg.indices, `hidden-${si}`)}
            </Collapsible>
          </Fragment>
        )
      })}
      {tail}
    </>
  )
}
