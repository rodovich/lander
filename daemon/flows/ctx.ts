// The driver `ctx` runtime: the object a flow's `onTurn(ctx)` is handed, and the
// machinery that turns its calls back into the neutral HostEvents the supervisor
// already understands. This is the seam the whole inversion turns on — a flow
// emitting through `ctx` must be indistinguishable on the wire from the compiled
// adapter it replaces, so most of the care here is about reproducing runAgent's
// exact wire behavior rather than about the API's ergonomics.
//
// Three properties are load-bearing and easy to break:
//
//  1. IDENTITY IS THE RUNTIME'S. Flows never see, supply, or forge the ids that
//     end up in Step.toolUseId / Step.inferenceId. They get opaque handles and
//     hand them back. That makes "a result folds onto another ride's item" — the
//     collision that forced ride-scoping in apply.ts — inexpressible at the API
//     level rather than merely guarded downstream.
//
//  2. THE FLUSH CADENCE IS PER STDOUT CHUNK, not per line. runAgent flushes once
//     per `data` event; a per-line flush would put many more UpdateMessages on
//     the wire (and many more serialized task writes) for identical content. The
//     cadence here falls out of `lines()`: emissions batch until the consumer
//     drains the queue and has to wait for the next chunk, and the flush happens
//     at that suspension point. An `await` inserted mid-loop by a flow therefore
//     changes wire granularity — that is a real part of the contract, and the
//     parity harness's wire-sequence assert is what pins it.
//
//  3. STATE REVISIONS SEED FROM THE SERVER'S. applyStatePatch drops any batch
//     with `rev <= task.flowStateRev`, so a counter restarting at 1 per run would
//     silently lose every ride's writes after the first. The seed comes in on
//     StartRunMessage.flowStateRev and the first batch is seed + 1.

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import type { FlowMeta, StatePatchOp } from '../../server/protocol'
import type { Step, Usage } from '../../server/stream'
import type { HostEvent, HostInput, SpawnLike } from '../run-agent'
import { buildRevivedBlock } from '../task-management'

// ── Handles ────────────────────────────────────────────────────────────────

// Opaque collapse-boundary handle (→ Step.inferenceId). Branded for the type
// checker; the actual id lives in a module-private WeakMap so a flow genuinely
// cannot read or fabricate it.
export type GroupHandle = { readonly __brand: 'lander.group' }

// Opaque tool-call handle (→ Step.toolUseId), plus the one thing a caller may do
// with it beyond passing it back: fold an outcome onto the running item.
export type ToolHandle = {
  readonly __brand: 'lander.tool'
  result(result: ToolResult): void
}

export type ToolResult = {
  output?: string
  isError?: boolean
  // A permission-gate refusal. This does NOT fold a tool_result step; it names
  // the call on the update's blockedIds, exactly where the terminal
  // permission_denials list lands today. A call can therefore take a real result
  // and a later blocked marking without emitting two results.
  blocked?: boolean
}

const handleIds = new WeakMap<object, string>()

// The durable-state size cap, owed since step 3. Enforced at the write in the
// host (see mutate): the server cannot enforce it, because dropping a batch
// there leaves flowStateRev unadvanced, so the next batch applies on top of the
// hole while the host reasons over state the server never received.
export const STATE_MAX_BYTES = 64 * 1024

// Enough for what a flow publishes — the server sanitizes and validates the
// name itself, and everything else falls back to plain text (not
// octet-stream, which would make a diff or a log download rather than render).
function guessArtifactMime(name: string): string {
  if (name.endsWith('.json')) return 'application/json'
  if (name.endsWith('.md')) return 'text/markdown'
  if (name.endsWith('.html')) return 'text/html'
  return 'text/plain'
}

function handleId(h: object): string | undefined {
  return handleIds.get(h)
}

// ── The ctx surface ────────────────────────────────────────────────────────

export type TurnAttachment = {
  id: string
  name: string
  mime: string
  size: number
  path: string
}

export type CtxTurn = {
  // The delivered user text. v1 is a single-element array: runTurn joins a
  // batch into one StartRunMessage.prompt before it reaches the wire. A future
  // additive `prompts` wire field upgrades this without a ctx change.
  prompts: string[]
  // The answer to THIS FLOW'S ask/wedge. Never populated at v1 — no wire field
  // carries a structured answer yet, and platform retry asks are composed and
  // enforced server-side, so they never surface here. A flow that asked and was
  // woken must tolerate this being absent regardless: any status crossing
  // withdraws open asks, which supersedes the question rather than losing it.
  answer?: StructuredAnswer
  attachments: TurnAttachment[]
  // Absolute paths of this turn's image blobs (the vision channel).
  images: string[]
  // The prompt-facing attachment manifest, already built by the daemon as part
  // of materializing the blobs. The flow decides whether and where to append it
  // (prompt assembly is the flow's job) but does not rebuild it: the block is a
  // pure function of inputs the daemon already had, and re-deriving it in the
  // host would risk a silent byte-level divergence that reads as a prompt-cache
  // miss rather than an error. A flow that materializes its own attachments can
  // still build one with buildManifestBlock from the stdlib.
  manifestBlock?: string
  // The one-turn "you were revived" notice, present only when an incoming
  // message pulled this task out of `wedged` or `landed`. Pre-built by the daemon
  // for the same reason as manifestBlock — the flow decides where it goes in the
  // prompt, not what it says. A flow that skips it just leaves the resumed
  // session believing its own wedge/land call still holds.
  revivedBlock?: string
  // The per-task attachment store. UNGATED on purpose: LANDER_FILES_DIR is set
  // from it with no existence check (the daemon always supplies it), so gating
  // here would diverge from the adapter on every task without attachments.
  filesDir?: string
  // The existence gate, which applies to --add-dir ONLY. One gated field cannot
  // express both values, hence the pair.
  filesDirExists: boolean
}

// Reserved shape for the answer that woke an asked/wedged task. Nothing
// populates it at v1; it exists so the ctx type is stable across the upgrade.
export type StructuredAnswer = {
  option?: string
  text?: string
}

export type CtxTask = {
  taskId: string
  project: string
  // The dir the child is spawned in — whatever resolveLaunchDir chose.
  cwd: string
  root: string
  // Argv the flow MUST prepend to its agent launch to reach its working state
  // (claude re-enters a worktree with ['--worktree', name]). Empty when none.
  reentryArgs: string[]
  // Where the shell lands once reentryArgs apply. The git snapshot and the
  // manual-cd hint read from `effectiveCwd ?? cwd`.
  effectiveCwd?: string
  // The cwd the previous turn's shell ended in, for the manual-cd hint.
  recordedCwd?: string
  allowEdits: boolean
  allow?: string[]
  worktree?: string
  // The run env (LANDER_API/TOKEN/TASK…). The flow merges this into its child
  // env; ctx.spawn merges the result over process.env.
  env: Record<string, string>
  // The task's opaque per-flow configuration, set at launch (picker or
  // `lander launch --flow x --key v`) and echoed on start-run. The server never
  // interprets it; the flow owns its meaning, including validating it and
  // failing safe on a value it doesn't recognize. (meta.inputs — a declared
  // schema the platform would validate — remains parked.)
  flowConfig?: Record<string, unknown>
}

export type EmitMessageOpts = {
  group?: GroupHandle
  parent?: ToolHandle
  // Marks this text the turn's reply (UpdateMessage.finalText) as well as a step.
  final?: boolean
}

export type EmitToolOpts = {
  name: string
  input: string
  inputFull?: string
  rule?: string
  edits?: { old: string; new: string }[]
  group?: GroupHandle
  parent?: ToolHandle
}

export type MeterOpts = {
  usage?: Usage
  drivingModel?: string
  rateLimitResetsAt?: string
}

export type CtxEmit = {
  message(text: string, opts?: EmitMessageOpts): void
  tool(opts: EmitToolOpts): ToolHandle
  group(): GroupHandle
  // The turn's reply text WITHOUT contributing a step. Claude's terminal
  // `result` event carries the authoritative reply having already streamed the
  // prose as assistant text — emitting a step here would duplicate the message
  // in the timeline. `message(text, { final: true })` is the other case: text
  // that is both a step and the reply.
  reply(text: string): void
  // The accumulator outputs, merged onto the NEXT flushed update. The flow owns
  // the accumulation (addUsage + the per-inference dedupe) and reports the
  // running total; `usageChanged` is set on a flush iff `usage` was supplied
  // since the last one. `drivingModel` and `rateLimitResetsAt` LATCH — once
  // given they ride every later flush, because the server's resume seq-dedupe
  // skips already-applied updates and a one-shot value on a skipped seq would be
  // unrecoverable after a restart (losing, say, the scheduled-retry timestamp).
  meter(opts: MeterOpts): void
}

export type CtxState = {
  get(path: string[]): unknown
  set(path: string[], value: unknown): void
  delete(path: string[]): void
  push(path: string[], value: unknown): void
  patch(path: string[], value: unknown): void
  // Put any pending writes on the wire now. Writes otherwise batch until a
  // ctx.spawn drain or the turn's end, so a flow that mutates the task through
  // an orchestration call (ask/wedge/rest) must flush first or risk losing the
  // write to an interrupt. The ctx orchestration wrappers do this for you; this
  // is for a flow's own transitions that don't go through one.
  flush(): void
}

export type SpawnOpts = {
  cwd?: string
  env?: Record<string, string>
  // Reserved at v1: the idle watchdog is supervisor-owned (keyed to
  // StartRunMessage.idleTimeoutMs, armed on host output) and no daemon→host
  // channel exists to convey a per-spawn override. Accepted and ignored.
  idleTimeoutMs?: number
}

export type SpawnedChild = {
  // Line-buffered stdout. Draining this iterator is what drives the flush
  // cadence — see the note at the top of this file.
  lines(): AsyncIterable<string>
  // Line-buffered stderr, for the flow's done aggregation. The runtime ALSO
  // tees every chunk to the host's stderr independently, so a flow that never
  // reads this cannot starve the daemon's idle watchdog.
  stderr: AsyncIterable<string>
  exit: Promise<number>
  kill(): void
}

export type CtxScratch = {
  dir: string
  // Whether the scratch survived intact since the last clean ride end.
  // Conservatively FALSE at v1: the host can be SIGKILLed at ride end and the
  // daemon doesn't know the runtime's final rev, so no process can reliably
  // stamp it yet. "Cold but informed" is always a correct assumption — server
  // state must suffice to resume correctly; scratch only makes it cheap.
  fresh: boolean
}

export type TurnResult = { exitCode: number; stderr?: string }

export type Ctx = {
  turn: CtxTurn
  task: CtxTask
  now(): string
  emit: CtxEmit
  state: CtxState
  scratch: CtxScratch
  spawn(cmd: string, args: string[], opts?: SpawnOpts): SpawnedChild
  // Reserved at v1. Every live supervisor kill path SIGKILLs the host process
  // GROUP, so nothing currently sends the host a SIGTERM and this never fires on
  // interrupt. Flows must tolerate abrupt kill — that is today's behavior. It
  // ships wired to host SIGTERM so a future TERM-then-KILL escalation in the
  // supervisor lights it up with no API change.
  signal: AbortSignal
  telemetry: CtxTelemetry
  artifacts: CtxArtifacts
  // Interaction + orchestration, over the public task API. The subset the
  // bundled flows consume is implemented; the rest stay reserved names that
  // throw, so the v1 type is stable and step 6 (which converges command flows
  // onto this same ctx, with async assist/shell) fills them in.
  //
  // Errors are THROWN, never process.exit — a driver can handle a failure
  // instead of vanishing, and runFlowTurn turns an unhandled rejection into a
  // done rather than a stranded host.

  // Advisory: renders options without blocking the task.
  ask(opts: AskOpts): Promise<unknown>
  // Task-blocking: the user must answer before the task rides again. With no
  // options it is a bare status change.
  wedge(opts?: AskOpts): Promise<unknown>
  launch(message: string, opts?: LaunchOpts): Promise<unknown>
  send(...args: unknown[]): Promise<unknown>
  // A task's public JSON, defaulting to this task. The way a flow reads back
  // its own answered ask.
  view(id?: string): Promise<unknown>
  list(...args: unknown[]): Promise<unknown>
  rest(opts?: RestOpts): Promise<unknown>
  relaunch(...args: unknown[]): Promise<unknown>
  land(...args: unknown[]): Promise<unknown>
  flow(...args: unknown[]): Promise<unknown>
  assist(...args: unknown[]): Promise<unknown>
  shell(...args: unknown[]): Promise<unknown>
}

export type CtxTelemetry = {
  set(items: unknown[]): void
}

export type CtxArtifacts = {
  put(name: string, content: string): Promise<unknown>
  list(): Promise<unknown>
  cat(name: string): Promise<unknown>
}

// One option on a flow-authored ask. `id` is what comes back on the answer, so
// a flow matches on it rather than on the label.
export type AskOption = { id: string; label: string; detail?: string }

export type AskOpts = {
  options?: AskOption[]
  prompt?: string
}

export type LaunchOpts = {
  title?: string
  flow?: string
  config?: Record<string, unknown>
  edits?: boolean
}

export type RestOpts = {
  date?: string
  time?: number
  await?: string
  clear?: boolean
}

// A driver flow module.
export type FlowModule = {
  meta: FlowMeta
  onTurn(ctx: Ctx): Promise<TurnResult>
  onGrant?(ctx: unknown, grant: { rule: string; scope: string }): Promise<void>
  onStatus?(): Promise<{ items: unknown[]; refreshAt?: string } | null>
  resolveLaunchDir?(input: unknown): unknown
}

// FlowMeta lives in server/protocol.ts — the shared contract module — because the
// server caches and serves it (the flow registry) as well as the daemon building
// it. Re-exported here so flow modules keep importing it from their own tree.
export type { FlowMeta }

// ── The runtime ────────────────────────────────────────────────────────────

export type CtxRuntimeDeps = {
  emit: (event: HostEvent) => void
  spawn?: SpawnLike
  now?: () => string
  // Tee target for spawned children's stderr — process.stderr in the host, so
  // agent-only stderr activity still reaches the daemon's idle watchdog.
  onStderr?: (chunk: string) => void
  scratchDir?: string
}

export type CtxRuntime = {
  ctx: Ctx
  // Run a flow to its done: awaits onTurn, kills anything it left running,
  // flushes, and emits the natural done. The single place the done contract is
  // enforced.
  runTurn(flow: { onTurn(ctx: Ctx): Promise<TurnResult> }): Promise<void>
  // The compiled-adapter bridge's entry point (see adapter-bridge.ts).
  bridge: BridgeApi
  // SIGKILL every child this runtime spawned. The host's exit/SIGTERM belt binds
  // to this, so a killed host leaves no orphan even when the flow, not the
  // child, is what ended.
  killChildren(): void
}

// The privileged surface the adapter bridge needs and flows must not have:
// verbatim createdAt (so bridging an adapter's steps changes ids and NOTHING
// else) and a manual flush (the adapter path has already chunked its own
// batches, so the bridge flushes once per incoming update event).
export type BridgeApi = {
  emitToolAt(opts: EmitToolOpts, createdAt: string): ToolHandle
  emitMessageAt(text: string, opts: EmitMessageOpts, createdAt: string): void
  resultAt(h: ToolHandle, result: ToolResult, createdAt: string): void
  replyAt(text: string): void
  meter(opts: MeterOpts): void
  group(): GroupHandle
  flush(): void
}

export function createCtxRuntime(
  input: HostInput,
  deps: CtxRuntimeDeps,
): CtxRuntime {
  const { start, root, cwd, effectiveCwd, materialized } = input
  const emitEvent = deps.emit
  const now = deps.now ?? (() => new Date().toISOString())
  const spawnFn = deps.spawn ?? nodeSpawn
  const runId = start.runId

  // ── Identity minting ─────────────────────────────────────────────────────
  // Ids are `<kind>:<runId>:<counter>`. The run id is the ride id, so ids are
  // stable across a buffer replay and never collide between rides — which is
  // what makes two consecutive rides that reuse the same provider-local ids
  // land on distinct items.
  let toolSeq = 0
  let groupSeq = 0

  // ── Emission batch ───────────────────────────────────────────────────────
  let steps: Step[] = []
  let finalText: string | undefined
  let blockedIds: string[] = []
  let usageChanged = false
  let liveUsage: Usage | undefined
  // Latched for the lifetime of the run — see CtxEmit.meter.
  let drivingModel: string | undefined
  let rateLimitResetsAt: string | undefined

  function flush(): void {
    // The empty-batch rule: a chunk that reduced to nothing puts nothing on the
    // wire (runAgent's flush does the same).
    if (
      !steps.length &&
      finalText === undefined &&
      !blockedIds.length &&
      !usageChanged
    )
      return
    emitEvent({
      kind: 'update',
      steps,
      finalText,
      blockedIds,
      usage: usageChanged ? liveUsage : undefined,
      usageChanged,
      drivingModel,
      rateLimitResetsAt,
    })
    steps = []
    finalText = undefined
    blockedIds = []
    usageChanged = false
  }

  // ── Durable state ────────────────────────────────────────────────────────
  // The blob is meant to hold decisions, identities, and user-visible progress —
  // a PR number, a run id, a phase — not bulk data. Anything derivable belongs
  // in ctx.scratch; anything large the user should see belongs in an artifact.
  // Seed the in-memory copy from flowState, falling back to the legacy top-level
  // wire fields for thread identity. This fallback is not a nicety: a task whose
  // session predates the storage flip keeps its sessionId at the legacy level
  // forever (the union read serves it, and the set-once guard means adapter
  // turns never copy it across). A flow reading only flowState would find
  // nothing, mint fresh, and silently abandon the conversation — while the
  // correct id rode in unused on the wire.
  const stateCopy: Record<string, unknown> = { ...(start.flowState ?? {}) }
  if (stateCopy.sessionId === undefined && start.sessionId !== undefined)
    stateCopy.sessionId = start.sessionId
  if (stateCopy.turnContext === undefined && start.turnContext !== undefined)
    stateCopy.turnContext = start.turnContext

  const revSeed = start.flowStateRev ?? 0
  let batchN = 0
  let pendingOps: StatePatchOp[] = []

  function flushState(): void {
    if (!pendingOps.length) return
    // nth batch of the run is seed + n, n starting at 1: the server's guard
    // drops `rev <= flowStateRev`, so a 0-based first batch on a resumed task
    // would be discarded.
    emitEvent({ kind: 'state-patch', ops: pendingOps, rev: revSeed + ++batchN })
    pendingOps = []
  }

  // The two thread-identity keys flush the instant they're written rather than
  // riding the chunk cadence — matching where runAgent emits `session` and
  // `turn-context` today (at spawn time, and mid-chunk for a provider that
  // reports its session in-stream). Both exist precisely so a crash or restart
  // cannot lose them: a turnContext baseline lost to a crash makes the next turn
  // re-send the whole block for nothing.
  const IMMEDIATE_KEYS = new Set(['sessionId', 'turnContext'])

  function pushOp(op: StatePatchOp): void {
    pendingOps.push(op)
    if (op.path.length === 1 && IMMEDIATE_KEYS.has(op.path[0])) flushState()
  }

  // Mirror the op onto the local copy so a later get within the same turn sees
  // the write. Deliberately the same walk applyStatePatch does server-side.
  function localApply(op: StatePatchOp): void {
    const { path, value } = op
    if (!path.length) return
    let node = stateCopy
    for (let i = 0; i < path.length - 1; i++) {
      const next = node[path[i]]
      if (next && typeof next === 'object' && !Array.isArray(next))
        node = next as Record<string, unknown>
      else node = (node[path[i]] = {} as Record<string, unknown>)
    }
    const leaf = path[path.length - 1]
    switch (op.op) {
      case 'set':
        node[leaf] = value
        break
      case 'delete':
        delete node[leaf]
        break
      case 'push': {
        const arr = node[leaf]
        if (Array.isArray(arr)) arr.push(value)
        else node[leaf] = [value]
        break
      }
      case 'patch': {
        const target = node[leaf]
        if (
          target &&
          typeof target === 'object' &&
          !Array.isArray(target) &&
          value &&
          typeof value === 'object' &&
          !Array.isArray(value)
        )
          Object.assign(target, value)
        else node[leaf] = value
        break
      }
    }
  }

  // Restore the pre-op value at `op.path`, so a rejected write leaves the local
  // copy matching what the server has. Captured by value before the op runs.
  function undoLocal(op: StatePatchOp, root: Record<string, unknown>): void {
    const { path } = op
    if (!path.length) return
    let node: Record<string, unknown> = root
    for (let i = 0; i < path.length - 1; i++) {
      const next = node[path[i]]
      if (!next || typeof next !== 'object') return
      node = next as Record<string, unknown>
    }
    const leaf = path[path.length - 1]
    if (undoValue === UNSET) delete node[leaf]
    else node[leaf] = undoValue
  }

  // The value displaced by the op currently being applied, so undoLocal can put
  // it back. A sentinel distinguishes "was absent" from "was undefined".
  const UNSET = Symbol('unset')
  let undoValue: unknown = UNSET

  function captureUndo(op: StatePatchOp): void {
    let node: unknown = stateCopy
    for (let i = 0; i < op.path.length - 1; i++) {
      if (!node || typeof node !== 'object') {
        undoValue = UNSET
        return
      }
      node = (node as Record<string, unknown>)[op.path[i]]
    }
    if (!node || typeof node !== 'object') {
      undoValue = UNSET
      return
    }
    const leaf = op.path[op.path.length - 1]
    const holder = node as Record<string, unknown>
    if (!(leaf in holder)) {
      undoValue = UNSET
      return
    }
    const prev = holder[leaf]
    // Deep-copy so a `push`/`patch` mutating in place can still be undone.
    undoValue =
      prev && typeof prev === 'object' ? JSON.parse(JSON.stringify(prev)) : prev
  }

  function mutate(op: StatePatchOp): void {
    captureUndo(op)
    // Enforce the cap HOST-SIDE, before localApply, so an over-cap write fails
    // visibly and atomically: the flow throws, and its local copy still matches
    // what the server has.
    //
    // The server cannot be the enforcement point. applyStatePatch drops a batch
    // without advancing flowStateRev, so the producer's NEXT batch is strictly
    // greater and applies on top of the hole — ops 5-8 landing while 1-4 are
    // gone — while the host, having already applied the dropped ops locally,
    // reasons over state the server does not have. Silent divergence is a worse
    // failure than a thrown write.
    const projected = JSON.stringify({ ...stateCopy })
    if (projected.length > STATE_MAX_BYTES) {
      throw new Error(
        `flow state exceeds ${STATE_MAX_BYTES} bytes (${projected.length}); ` +
          `put bulk data in ctx.scratch or an artifact`,
      )
    }
    localApply(op)
    // Re-check after applying: the projection above is the pre-write size, so a
    // single huge value would otherwise slip through once.
    const after = JSON.stringify(stateCopy)
    if (after.length > STATE_MAX_BYTES) {
      // Undo, so the local copy still matches what the server will have.
      undoLocal(op, stateCopy)
      throw new Error(
        `flow state would exceed ${STATE_MAX_BYTES} bytes (${after.length}); ` +
          `put bulk data in ctx.scratch or an artifact`,
      )
    }
    pushOp(op)
  }

  const state: CtxState = {
    get(path) {
      let node: unknown = stateCopy
      for (const key of path) {
        if (!node || typeof node !== 'object') return undefined
        node = (node as Record<string, unknown>)[key]
      }
      return node
    },
    set: (path, value) => mutate({ op: 'set', path, value }),
    delete: (path) => mutate({ op: 'delete', path }),
    push: (path, value) => mutate({ op: 'push', path, value }),
    patch: (path, value) => mutate({ op: 'patch', path, value }),
    // "Make my writes durable now." Exists because a flow-authored helper (the
    // open-PR flow's setPhase) has to be able to get a phase write onto the
    // wire before an orchestration call that mutates the task — and state
    // batches lazily, with the only mid-turn flush being a ctx.spawn drain. A
    // flow in an ask-only phase never spawns a child, so without this nothing
    // flushes until the turn ends, and a kill mid-call loses the write.
    //
    // Chosen over adding a `phase` key to IMMEDIATE_KEYS, which would put one
    // flow's vocabulary into generic runtime code.
    flush: () => flushState(),
  }

  // ── Emission API ─────────────────────────────────────────────────────────

  function makeToolHandle(): ToolHandle {
    const h = {
      __brand: 'lander.tool',
      result(result: ToolResult) {
        resultAt(h as ToolHandle, result, now())
      },
    } as unknown as ToolHandle
    return h
  }

  function emitToolAt(opts: EmitToolOpts, createdAt: string): ToolHandle {
    const h = makeToolHandle()
    const id = `tool:${runId}:${toolSeq++}`
    handleIds.set(h, id)
    const parentId = opts.parent ? handleId(opts.parent) : undefined
    const groupIdValue = opts.group ? handleId(opts.group) : undefined
    steps.push({
      kind: 'tool_use',
      tool: opts.name,
      input: opts.input,
      ...(opts.inputFull !== undefined ? { inputFull: opts.inputFull } : {}),
      toolUseId: id,
      ...(groupIdValue !== undefined ? { inferenceId: groupIdValue } : {}),
      ...(parentId !== undefined ? { parentToolUseId: parentId } : {}),
      ...(opts.rule !== undefined ? { rule: opts.rule } : {}),
      ...(opts.edits !== undefined ? { edits: opts.edits } : {}),
      createdAt,
    })
    return h
  }

  function emitMessageAt(
    text: string,
    opts: EmitMessageOpts,
    createdAt: string,
  ): void {
    const parentId = opts.parent ? handleId(opts.parent) : undefined
    const groupIdValue = opts.group ? handleId(opts.group) : undefined
    steps.push({
      kind: 'text',
      text,
      ...(groupIdValue !== undefined ? { inferenceId: groupIdValue } : {}),
      ...(parentId !== undefined ? { parentToolUseId: parentId } : {}),
      createdAt,
    })
    if (opts.final) finalText = text
  }

  function resultAt(
    h: ToolHandle,
    result: ToolResult,
    createdAt: string,
  ): void {
    const id = handleId(h)
    if (id === undefined) return
    // `blocked` names the call on the update's blockedIds; it is NOT a second
    // result step, so a call can be resolved and later marked blocked.
    if (result.blocked) blockedIds.push(id)
    if (result.output === undefined && result.isError === undefined) return
    steps.push({
      kind: 'tool_result',
      ...(result.output !== undefined ? { text: result.output } : {}),
      toolUseId: id,
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
      createdAt,
    })
  }

  const emit: CtxEmit = {
    message: (text, opts = {}) => emitMessageAt(text, opts, now()),
    tool: (opts) => emitToolAt(opts, now()),
    group() {
      const g = { __brand: 'lander.group' } as unknown as GroupHandle
      handleIds.set(g, `group:${runId}:${groupSeq++}`)
      return g
    },
    reply(text) {
      finalText = text
    },
    meter({ usage, drivingModel: model, rateLimitResetsAt: resets }) {
      if (usage) {
        liveUsage = usage
        usageChanged = true
      }
      if (model) drivingModel = model
      if (resets) rateLimitResetsAt = resets
    },
  }

  // ── Processes ────────────────────────────────────────────────────────────

  const children = new Set<ChildProcess>()

  function spawn(
    cmd: string,
    args: string[],
    opts: SpawnOpts = {},
  ): SpawnedChild {
    const child = spawnFn(cmd, args, {
      cwd: opts.cwd ?? cwd,
      // Merge over the host's own env, exactly as runAgent spawns today. Env
      // scrubbing is deliberately a later step.
      env: { ...process.env, ...(opts.env ?? {}) },
      // Never detached: the supervisor's group SIGKILL (interrupt / idle /
      // shutdown) reaches a spawned child only through group membership.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.add(child)

    const stdoutQ = new LineQueue()
    const stderrQ = new LineQueue()
    let buf = ''
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        stdoutQ.push(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
      }
      stdoutQ.wake()
    })
    child.stdout?.on('end', () => {
      // A trailing partial line still counts — runAgent's final flush(true)
      // takes whatever is left in its buffer.
      if (buf) stdoutQ.push(buf)
      buf = ''
      stdoutQ.close()
    })
    child.stderr?.on('data', (d: Buffer) => {
      const text = d.toString()
      // TEE, not hand-off: the relay happens whether or not the flow ever reads
      // child.stderr. The daemon arms its idle watchdog on host stderr, and a
      // stdout chunk reducing to an empty batch emits no HostEvent at all — so
      // stderr is sometimes the only liveness signal crossing the boundary.
      deps.onStderr?.(text)
      stderrQ.pushChunk(text)
      stderrQ.wake()
    })
    child.stderr?.on('end', () => stderrQ.close())

    const exit = new Promise<number>((resolve) => {
      child.on('error', () => {
        stdoutQ.close()
        stderrQ.close()
        resolve(1)
      })
      child.on('close', (code) => {
        stdoutQ.close()
        stderrQ.close()
        resolve(code == null ? 1 : code)
      })
    })

    return {
      // Flushing when the queue drains is what makes the batch boundary the
      // stdout chunk: every line of one chunk is already queued, so the consumer
      // walks them without suspending on new data, and the flush lands exactly
      // once at the end.
      lines: () =>
        stdoutQ.drain(() => {
          flush()
          flushState()
        }),
      stderr: stderrQ.drain(() => {}),
      exit,
      kill: () => {
        try {
          child.kill('SIGKILL')
        } catch {}
      },
    }
  }

  function killChildren(): void {
    for (const child of children) {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
  }

  // ── Assembly ─────────────────────────────────────────────────────────────

  const abort = new AbortController()

  const filesDir = input.filesDir

  const attachments: TurnAttachment[] = (start.attachments ?? []).map((ref) => ({
    id: ref.id,
    name: ref.name,
    mime: ref.mime,
    size: ref.size,
    // The refs carry no path; the local file is id-keyed inside filesDir. Joining
    // them here is why ctx.turn.attachments needs both halves — MaterializedFiles
    // alone ({ manifestBlock, images, filesDir }) has no refs.
    path: filesDir ? `${filesDir}/${ref.id}` : ref.id,
  }))

  const notImplemented = (name: string) => async (): Promise<never> => {
    throw new Error(
      `ctx.${name} is not implemented at driver API v1 (no bundled flow consumes it yet)`,
    )
  }

  // ── Orchestration over the public task API ───────────────────────────────
  // The host reaches the server the same way the in-task `lander` CLI does:
  // HTTP with the task's own token, which rides in on start-run's env. The
  // daemon already fetches over this env every turn, so the path is proven.
  //
  // Request shapes are copied from bin/lander's makeLander, which is not
  // importable (it lives inside the CLI executable).
  const api = start.env.LANDER_API
  const apiProject = start.env.LANDER_PROJECT
  const apiTask = start.env.LANDER_TASK
  const apiToken = start.env.LANDER_TOKEN

  async function apiCall(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<unknown> {
    if (!api) throw new Error('ctx: LANDER_API is unset; no server to call')
    // BOTH buffers, before every call. This is correctness, not hygiene.
    //
    // ctx.emit and ctx.state batch lazily — the only mid-turn flush is a
    // ctx.spawn drain — while an orchestration call mutates the task
    // IMMEDIATELY. A flow in an ask-only phase never spawns a child, so without
    // this an interrupt after (say) ctx.wedge leaves the user looking at a
    // wedge with buttons above an EMPTY ride, and the flow's phase write lost.
    // The emission loss is the worse of the two: re-entry lands in the next
    // phase and never re-emits.
    //
    // Precisely what this buys: bytes on the host's stdout, which the daemon
    // forwards and the server applies asynchronously through the run channel,
    // while this fetch mutates the task file directly. So it is "on the wire,
    // not applied" — enough that nothing is lost to a SIGKILL, but NOT an
    // ordering guarantee between the emitted items and the ask this creates.
    // Don't build anything that depends on that ordering.
    flush()
    flushState()
    const res = await fetch(`${api}/api/${apiProject}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(apiTask ? { 'x-lander-task': apiTask } : {}),
        ...(apiProject ? { 'x-lander-project': apiProject } : {}),
        ...(apiToken ? { 'x-lander-token': apiToken } : {}),
      },
      ...(init?.body !== undefined
        ? { body: JSON.stringify(init.body) }
        : {}),
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    // Thrown, never process.exit — the v1 contract. runFlowTurn turns a
    // rejection into a `done { exitCode: 1 }`, so a failed call settles the
    // ride instead of stranding the host.
    if (!res.ok)
      throw new Error(
        typeof body.error === 'string'
          ? body.error
          : `${res.status} ${res.statusText}`,
      )
    return body
  }

  // Publish an artifact. The route takes MULTIPART, not JSON — `parseBody()`
  // with a `file` part — so this can't go through apiCall. Mirrors bin/lander's
  // putArtifact: the blob's filename is the slot name, with an explicit `name`
  // field only when overriding it.
  async function putArtifact(name: string, content: string): Promise<unknown> {
    if (!api) throw new Error('ctx: LANDER_API is unset; no server to call')
    flush()
    flushState()
    const fd = new FormData()
    fd.append('file', new Blob([content], { type: guessArtifactMime(name) }), name)
    fd.append('name', name)
    const res = await fetch(`${api}/api/${apiProject}/tasks/${apiTask}/artifacts`, {
      method: 'POST',
      headers: {
        ...(apiTask ? { 'x-lander-task': apiTask } : {}),
        ...(apiProject ? { 'x-lander-project': apiProject } : {}),
        ...(apiToken ? { 'x-lander-token': apiToken } : {}),
      },
      body: fd,
    })
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok)
      throw new Error(
        typeof body.error === 'string'
          ? body.error
          : `${res.status} ${res.statusText}`,
      )
    return body.artifact
  }

  // The blob, as text. The GET returns raw bytes rather than JSON, so this also
  // bypasses apiCall.
  async function catArtifact(name: string): Promise<string> {
    if (!api) throw new Error('ctx: LANDER_API is unset; no server to call')
    flush()
    flushState()
    const res = await fetch(
      `${api}/api/${apiProject}/tasks/${apiTask}/artifacts/${encodeURIComponent(name)}`,
      {
        headers: {
          ...(apiTask ? { 'x-lander-task': apiTask } : {}),
          ...(apiProject ? { 'x-lander-project': apiProject } : {}),
          ...(apiToken ? { 'x-lander-token': apiToken } : {}),
        },
      },
    )
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
      throw new Error(
        typeof body.error === 'string'
          ? body.error
          : `${res.status} ${res.statusText}`,
      )
    }
    return res.text()
  }

  // Raise an ask. `blocking: 'task'` wedges the task (the user must answer
  // before it rides again); 'none' is advisory and leaves it resting. Returns
  // the created ask, so a caller could hold its id — though the open-PR flow
  // deliberately reads its ask back from the item log instead, since the id
  // does not exist until this resolves.
  async function raiseAsk(
    options: { id: string; label: string; detail?: string }[] | undefined,
    blocking: 'task' | 'none',
    prompt?: string,
  ): Promise<unknown> {
    if (!options?.length) {
      // A bare wedge with no options is just a status change.
      if (blocking === 'task')
        return apiCall(`/tasks/${apiTask}`, {
          method: 'PATCH',
          body: { status: 'wedged' },
        })
      throw new Error('ctx.ask requires at least one option')
    }
    const body = (await apiCall(`/tasks/${apiTask}/asks`, {
      method: 'POST',
      body: {
        ...(prompt ? { prompt } : {}),
        form: { type: 'choice', options },
        blocking,
      },
    })) as { ask?: unknown }
    return body.ask ?? body
  }

  const ctx: Ctx = {
    turn: {
      prompts: [start.prompt],
      attachments,
      images: materialized?.images ?? [],
      ...(materialized?.manifestBlock
        ? { manifestBlock: materialized.manifestBlock }
        : {}),
      ...(start.revived
        ? { revivedBlock: buildRevivedBlock(start.revived) }
        : {}),
      filesDir,
      filesDirExists: filesDir ? existsSync(filesDir) : false,
    },
    task: {
      taskId: start.taskId,
      project: start.project,
      cwd,
      root,
      reentryArgs: input.reentryArgs ?? [],
      ...(effectiveCwd !== undefined ? { effectiveCwd } : {}),
      ...(start.recordedCwd !== undefined
        ? { recordedCwd: start.recordedCwd }
        : {}),
      allowEdits: start.task.allowEdits,
      ...(start.task.allow !== undefined ? { allow: start.task.allow } : {}),
      ...(start.task.worktree !== undefined
        ? { worktree: start.task.worktree }
        : {}),
      env: start.env,
      // The task's opaque per-flow config, echoed by the server from the task
      // and handed to the flow verbatim. Absent when the task carries none.
      ...(start.flowConfig !== undefined
        ? { flowConfig: start.flowConfig }
        : {}),
    },
    now,
    emit,
    state,
    scratch: { dir: deps.scratchDir ?? filesDir ?? cwd, fresh: false },
    spawn,
    signal: abort.signal,
    telemetry: {
      set() {
        throw new Error(
          'ctx.telemetry.set is not implemented at driver API v1 (the per-task footer stays client-side)',
        )
      },
    },
    artifacts: {
      put: putArtifact,
      list: async () =>
        ((await apiCall(`/tasks/${apiTask}/artifacts`)) as {
          artifacts?: unknown
        }).artifacts ?? [],
      cat: catArtifact,
    },
    ask: (opts) => raiseAsk(opts?.options, 'none', opts?.prompt),
    wedge: (opts) => raiseAsk(opts?.options, 'task', opts?.prompt),
    launch: (message, opts) =>
      apiCall('/tasks', {
        method: 'POST',
        body: {
          message,
          ...(opts?.title ? { title: opts.title } : {}),
          ...(opts?.flow ? { flow: opts.flow } : {}),
          ...(opts?.config ? { flowConfig: opts.config } : {}),
          allowEdits: !!opts?.edits,
        },
      }),
    send: notImplemented('send'),
    // Reads a task through the public API — including this one, which is how a
    // flow reads back its own answered ask (publicTask passes `items` through
    // untouched, and an AskItem carries state/answer).
    view: (id) => apiCall(`/tasks/${id ?? apiTask}`),
    list: notImplemented('list'),
    rest: (opts) =>
      apiCall(`/tasks/${apiTask}/rest`, {
        method: 'POST',
        body: {
          ...(opts?.date ? { date: opts.date } : {}),
          ...(opts?.time !== undefined ? { time: opts.time } : {}),
          ...(opts?.await ? { await: opts.await } : {}),
          ...(opts?.clear ? { clear: true } : {}),
        },
      }),
    relaunch: notImplemented('relaunch'),
    land: notImplemented('land'),
    flow: notImplemented('flow'),
    assist: notImplemented('assist'),
    shell: notImplemented('shell'),
  }

  async function runFlowTurn(flow: {
    onTurn(ctx: Ctx): Promise<TurnResult>
  }): Promise<void> {
    let outcome: TurnResult
    try {
      outcome = await flow.onTurn(ctx)
    } catch (e) {
      outcome = {
        exitCode: 1,
        stderr: e instanceof Error ? e.message : String(e),
      }
    }
    // Settling reaps. Today `done ⇒ child dead` holds because runAgent only ever
    // emits done on child close — but a flow can throw mid-loop or return before
    // its child exits, and nothing downstream would reap it: the supervisor
    // clears the idle timer on settle and never kills after a natural done, the
    // run record drops after the buffer TTL, and the host group is detached. An
    // unkilled child would be a permanent orphan.
    killChildren()
    flush()
    flushState()
    emitEvent({
      kind: 'done',
      exitCode: outcome.exitCode,
      stderr: outcome.stderr ?? '',
    })
  }

  return {
    ctx,
    runTurn: runFlowTurn,
    killChildren,
    bridge: {
      emitToolAt,
      emitMessageAt,
      resultAt,
      replyAt: emit.reply,
      meter: emit.meter,
      group: emit.group,
      flush,
    },
  }
}

// A queue of complete lines with a suspension hook: `drain(onIdle)` yields
// everything queued, then calls `onIdle` and waits. That hook is where the
// per-chunk flush happens.
class LineQueue {
  private items: string[] = []
  private closed = false
  private waiter: (() => void) | null = null
  private partial = ''

  push(line: string): void {
    this.items.push(line)
  }

  // stderr arrives as raw chunks; split it into lines the same way, keeping any
  // trailing partial for the next chunk.
  pushChunk(text: string): void {
    this.partial += text
    let nl: number
    while ((nl = this.partial.indexOf('\n')) >= 0) {
      this.items.push(this.partial.slice(0, nl))
      this.partial = this.partial.slice(nl + 1)
    }
  }

  wake(): void {
    const w = this.waiter
    this.waiter = null
    w?.()
  }

  close(): void {
    if (this.partial) {
      this.items.push(this.partial)
      this.partial = ''
    }
    this.closed = true
    this.wake()
  }

  drain(onIdle: () => void): AsyncIterable<string> {
    const self = this
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (self.items.length) {
            yield self.items.shift() as string
            continue
          }
          if (self.closed) return
          onIdle()
          await new Promise<void>((resolve) => {
            self.waiter = resolve
          })
        }
      },
    }
  }
}
