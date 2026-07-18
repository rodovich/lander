// The compiled-adapter compatibility bridge.
//
// Until each provider's live path is a flow, the adapters keep returning `Step[]`
// carrying *provider-local* ids — claude's `toolu_…`, codex's item ids. Those ids
// are the reason apply.ts had to scope result matching by ride: two rides of the
// same task can reuse the same local id, and a result would otherwise fold onto
// the wrong ride's item.
//
// This bridge runs the adapter path's outgoing steps back through the ctx
// runtime's handle API, so the ids on the wire become runtime-minted ones for the
// adapter path too. Two things fall out of that: the collision class is closed at
// the source rather than merely contained downstream, and — the reason it lands
// before either cutover — the adapter oracle and the ported flow mint IDENTICAL
// ids from the same encounter order, which is what lets the parity harness
// deep-equal whole task JSONs instead of normalizing ids away.
//
// It knows the legacy `Step` vocabulary and nothing about any provider's id
// format or reuse rules. It is transitional: after a provider's cutover its flow
// uses handles directly, and step 5 deletes runAgent, the adapters, and this
// bridge together. The runtime's minter is the permanent mechanism.

import type { Step } from '../../server/stream'
import type { HostEvent } from '../run-agent'
import type { BridgeApi, GroupHandle, ToolHandle } from './ctx'

export type AdapterBridge = {
  // Translate one seq-less `update` HostEvent from the adapter path into the
  // normalized one the runtime produces. Returns nothing: the runtime emits.
  update(event: Extract<HostEvent, { kind: 'update' }>): void
}

export function createAdapterBridge(bridge: BridgeApi): AdapterBridge {
  const group = bridge.group
  // Provider-local id → runtime handle, for this run only.
  const tools = new Map<string, ToolHandle>()
  const groups = new Map<string, GroupHandle>()

  function groupFor(inferenceId: string | undefined): GroupHandle | undefined {
    if (inferenceId === undefined) return undefined
    let g = groups.get(inferenceId)
    if (!g) groups.set(inferenceId, (g = group()))
    return g
  }

  function parentFor(id: string | undefined): ToolHandle | undefined {
    if (id === undefined) return undefined
    // A parent id we never saw open can't be resolved to a handle; drop the
    // nesting rather than inventing an item. The step still lands, just at top
    // level — the same thing the server's own fallback does.
    return tools.get(id)
  }

  function openTool(step: Step, localId: string | undefined): ToolHandle {
    const h = bridge.emitToolAt(
      {
        name: step.tool ?? '',
        input: step.input ?? '',
        ...(step.inputFull !== undefined ? { inputFull: step.inputFull } : {}),
        ...(step.rule !== undefined ? { rule: step.rule } : {}),
        ...(step.edits !== undefined ? { edits: step.edits } : {}),
        ...(groupFor(step.inferenceId) !== undefined
          ? { group: groupFor(step.inferenceId) }
          : {}),
        ...(parentFor(step.parentToolUseId) !== undefined
          ? { parent: parentFor(step.parentToolUseId) }
          : {}),
      },
      step.createdAt,
    )
    if (localId !== undefined) tools.set(localId, h)
    return h
  }

  return {
    update(event) {
      for (const step of event.steps) {
        if (step.kind === 'tool_use') {
          openTool(step, step.toolUseId)
        } else if (step.kind === 'text') {
          bridge.emitMessageAt(
            step.text ?? '',
            {
              ...(groupFor(step.inferenceId) !== undefined
                ? { group: groupFor(step.inferenceId) }
                : {}),
              ...(parentFor(step.parentToolUseId) !== undefined
                ? { parent: parentFor(step.parentToolUseId) }
                : {}),
            },
            step.createdAt,
          )
        } else {
          // tool_result. A result whose call we never saw opened (codex reports
          // `item.failed` for a command it never announced starting) is
          // normalized into an open→result pair here rather than crossing as an
          // orphan for apply.ts's fallback to adopt. The synthesized open
          // carries no name or input the fallback wasn't already missing, and
          // ride-scoping contains it — but it IS a shape change, not purely an
          // id change, so it is called out rather than glossed.
          const localId = step.toolUseId
          let h = localId !== undefined ? tools.get(localId) : undefined
          if (!h)
            h = openTool(
              { ...step, kind: 'tool_use', tool: step.tool, input: step.input },
              localId,
            )
          bridge.resultAt(
            h,
            {
              ...(step.text !== undefined ? { output: step.text } : {}),
              ...(step.isError !== undefined ? { isError: step.isError } : {}),
            },
            step.createdAt,
          )
        }
      }

      // Denied calls are named after the fact by the terminal result event.
      // Resolve each through the handle map so the wire's blockedIds carry
      // runtime ids like everything else. A denied id we never saw open is
      // dropped: it could not have folded onto any item server-side either, so
      // dropping it preserves behavior.
      for (const localId of event.blockedIds ?? []) {
        const h = tools.get(localId)
        if (h) bridge.resultAt(h, { blocked: true }, '')
        else
          process.stderr.write(
            `flow-host: dropping blocked id with no observed tool_use: ${localId}\n`,
          )
      }

      if (event.finalText !== undefined) bridge.replyAt(event.finalText)
      bridge.meter({
        ...(event.usageChanged && event.usage ? { usage: event.usage } : {}),
        ...(event.drivingModel !== undefined
          ? { drivingModel: event.drivingModel }
          : {}),
        ...(event.rateLimitResetsAt !== undefined
          ? { rateLimitResetsAt: event.rateLimitResetsAt }
          : {}),
      })
      // The adapter path already chunked its own batches, so one incoming update
      // is exactly one outgoing update. The runtime's empty-batch rule still
      // applies, matching runAgent's.
      bridge.flush()
    },
  }
}
