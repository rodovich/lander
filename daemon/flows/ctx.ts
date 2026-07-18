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
import type { StatePatchOp } from '../../server/protocol'
import type { Step, Usage } from '../../server/stream'
import type { HostEvent, HostInput, SpawnLike } from '../run-agent'

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
  // Reserved: meta.inputs is parked until the flow registry lands.
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
  // Interaction + orchestration: reserved names so the v1 type is stable. These
  // throw until a flow consumes them (step 6 converges command flows onto this
  // same ctx, with async assist/shell and thrown errors); the ported claude and
  // codex drivers call none of them.
  ask(opts: { options?: unknown }): Promise<void>
  wedge(opts?: { options?: unknown }): Promise<void>
  launch(...args: unknown[]): Promise<unknown>
  send(...args: unknown[]): Promise<unknown>
  view(...args: unknown[]): Promise<unknown>
  list(...args: unknown[]): Promise<unknown>
  rest(...args: unknown[]): Promise<unknown>
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
  put(pathOrBytes: unknown, opts?: unknown): Promise<unknown>
  list(): Promise<unknown>
  cat(name: string): Promise<unknown>
}

// A driver flow module.
export type FlowModule = {
  meta: FlowMeta
  onTurn(ctx: Ctx): Promise<TurnResult>
  onGrant?(ctx: unknown, grant: { rule: string; scope: string }): Promise<void>
  onStatus?(): Promise<{ items: unknown[]; refreshAt?: string } | null>
  resolveLaunchDir?(input: unknown): unknown
}

export type FlowMeta = {
  api: number
  name: string
  description: string
  driver: boolean
  capabilities: {
    worktrees: boolean
    vision: 'read' | 'flag'
    grants: { task: boolean; project: boolean }
    usageSnapshot: boolean
    rateLimitRetry: boolean
  }
  inputs?: Record<string, unknown>
  // The human-facing reason a project-scope grant is refused, for a flow whose
  // capabilities.grants.project is false.
  projectGrantsUnsupportedReason?: string
}

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

  function mutate(op: StatePatchOp): void {
    localApply(op)
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

  const ctx: Ctx = {
    turn: {
      prompts: [start.prompt],
      attachments,
      images: materialized?.images ?? [],
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
      put: notImplemented('artifacts.put'),
      list: notImplemented('artifacts.list'),
      cat: notImplemented('artifacts.cat'),
    },
    ask: notImplemented('ask'),
    wedge: notImplemented('wedge'),
    launch: notImplemented('launch'),
    send: notImplemented('send'),
    view: notImplemented('view'),
    list: notImplemented('list'),
    rest: notImplemented('rest'),
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
