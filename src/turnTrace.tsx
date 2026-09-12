import { Fragment } from 'react'
import type { TaskLinkResolver } from './markdown'
import { MessageText } from './messageText'
import { TaskActionTransition } from './taskActionTransition'
import { Collapsible, ToolStep } from './toolStep'
import { planTurnActions } from './turnActions'
import { groupInferences, planTurnCollapse } from './turnCollapse'
import type { RideItem } from './timeline'
import type { TaskActionItem } from './types'

// The cross-task actions anchored at one point in the trace, as one block. They
// stack unruled: what a turn did to other tasks in one stretch of work reads as
// a single aside, not as a row per action.
function TurnActions({
  actions,
  linkTask,
}: {
  actions: TaskActionItem[]
  linkTask: TaskLinkResolver
}) {
  return (
    <div className="turn-notes">
      {actions.map((action) => (
        <TaskActionTransition
          key={`ta-${action.id}`}
          item={action}
          inTurn
          linkTask={linkTask}
        />
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
  linkTask,
  openDetails,
  onToggleDetail,
  expandedTurns,
  onToggleTurn,
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
  linkTask: TaskLinkResolver
  openDetails: Set<string>
  onToggleDetail: (key: string, keys: string[]) => void
  expandedTurns: Set<string>
  onToggleTurn: (key: string) => void
}) {
  // Subagent items (parentId set) don't render inline — they fold into their
  // spawning tool chip. Map each spawning tool id to its direct children's
  // indices so renderItem can nest them; the links go arbitrarily deep, so
  // rendering a child recurses on its own children in turn.
  const childrenByParent = new Map<string, number[]>()
  items.forEach((it, j) => {
    if (it.parentId) {
      const sibs = childrenByParent.get(it.parentId)
      if (sibs) sibs.push(j)
      else childrenByParent.set(it.parentId, [j])
    }
  })
  // The main thread: items with no parent. Subagent items are folded under
  // their spawning chip, so they never open a main-thread group nor feed
  // collapse/copy controls.
  const mainIdxs = items.map((_, j) => j).filter((j) => !items[j].parentId)
  // Ids of every tool chip with revealable detail (full input, a diff, captured
  // output, or a nested subagent trace) in this ride, so an option/shift-click
  // on one toggles them all together — nested chips included, since ids are
  // ride-wide.
  const detailKeys = items
    .map((it) =>
      it.kind === 'tool' &&
      (it.inputFull ||
        it.input.includes('\n') ||
        it.edits?.length ||
        it.output ||
        childrenByParent.has(it.id))
        ? it.id
        : null,
    )
    .filter((k): k is string => k !== null)
  // Group consecutive main items by the groupId that produced them (see
  // groupInferences). Each group is one inference — ruled apart from the next.
  const groupByGroup = (idxs: number[]) => groupInferences(items, idxs)
  // Settled turns fold down by their flow messages, independent of group
  // boundaries: keep the opening prose before the first tool, the longest text
  // sequence, and the last, collapsing the ranges between (see
  // planTurnCollapse). An open ride renders in full, as does any turn too short
  // to have a gap.
  const collapse = planTurnCollapse(items, mainIdxs)
  // Where this turn's cross-task actions land: each before the next prose
  // section the fold keeps, so a note whose `lander launch` is inside a folded
  // stretch surfaces under that stretch's summary instead of hiding behind it.
  const anchored = planTurnActions(items, mainIdxs, actions, collapse)

  const renderBody = (j: number) => {
    const it = items[j]
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
            onToggleDetail(it.id, all ? detailKeys : [it.id])
          }
          subItems={subItems}
        />
      )
    }
    if (it.kind === 'message') {
      // A flow message item: its prose. The open ask renders as the whole
      // turn's footer, not inline with whatever prose happened to precede the
      // wedge.
      return <MessageText key={it.id} text={it.text} linkTask={linkTask} />
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
        <TurnActions actions={notes} linkTask={linkTask} />
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
              <TurnActions actions={lead} linkTask={linkTask} />
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
      <TurnActions actions={anchored.tail} linkTask={linkTask} />
    </>
  )
  const folds = settled && collapse.segments.some((seg) => seg.hidden)
  if (!folds)
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
        // Summarize as the model's actions: one "step" per inference group (the
        // runs a turn-sep rules apart, so groups = turn-seps + 1), plus the tool
        // count.
        const stepCount = groupByGroup(seg.indices).length
        const toolCount = seg.indices.filter(
          (j) => items[j].kind === 'tool',
        ).length
        return (
          <Fragment key={`seg-${si}`}>
            {sep}
            <Collapsible
              open={open}
              onToggle={() => onToggleTurn(segKey)}
              label={
                <span className="collapsible-label">
                  {stepCount} step
                  {stepCount === 1 ? '' : 's'}
                  {toolCount > 0 &&
                    `, ${toolCount} tool${toolCount === 1 ? '' : 's'}`}
                  …
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
