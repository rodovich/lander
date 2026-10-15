import type { ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { ProviderCaps } from './flows/index'
import type {
  CheckoutReport,
  DoneCause,
  DoneMessage,
  SessionMessage,
  StartRunMessage,
  StatePatchMessage,
  TurnContextMessage,
  UpdateMessage,
} from '../server/protocol'
import type { MaterializedFiles } from './attachments'
import { checkoutReport as readCheckoutReport, gitWithin } from './checkout'
import { ROOT } from './paths'
import type { HostEvent, HostInput } from './host-protocol'
import {
  endStdin,
  HOST_STOP_GRACE_MS,
  killProcessGroup,
  onLines,
  spawnHostProcess,
} from './processes'

// Spawn a flow host for one run. Injectable so tests substitute a fake host;
// the default spawns daemon/flow-host.ts.
export type SpawnHostLike = () => ChildProcess

// The host runs at lander's root (see spawnHostProcess); the agent's own cwd
// rides in the HostInput.
const HOST_ENTRY = path.join(ROOT, 'daemon', 'flow-host.ts')

export type RunManagerMessage =
  | UpdateMessage
  | DoneMessage
  | SessionMessage
  | TurnContextMessage
  | StatePatchMessage

export type RunManager = {
  startRun: (msg: StartRunMessage) => void
  interrupt: (runId: string) => void
  resumeFrom: (runId: string, seq: number) => void
  ack: (runId: string) => void
  // Stop every spawned run's host and refuse to spawn any more, a pending run's
  // included; resolves once those hosts have closed.
  stopAll: () => Promise<void>
  // Settle a run as failed through the settle-once gate — see Run.fail.
  failRun: (runId: string, stderr: string) => void
  heldRunIds: () => string[]
  size: () => number
}

type Run = {
  interrupt: () => void
  // Settle this run as failed THROUGH the settle-once gate, for a synchronous
  // throw caught outside the run's own machinery. Routing it here rather than
  // sending a raw done matters: a bare send would settle the ride server-side
  // while the daemon still held the run, so runsHeld() would never drop and
  // drain.check() would never fire — pinning a draining daemon to the 12h
  // supervisor backstop.
  fail: (stderr: string) => void
  // Stop the flow host (see stopHost); resolves once it has closed.
  stop: () => Promise<void>
  buffer: UpdateMessage[]
  mintedSession?: string
  // The dynamic context block appended to this run's prompt (when it changed),
  // re-sent on resume-from — like mintedSession — so a server restart between
  // the announcement and its receipt can't lose the record.
  sentContext?: string
  // A flow's durable-state batches, buffered and re-sent on resume-from like
  // sentContext / mintedSession, so a server restart mid-turn can't lose a write.
  // The server's applyStatePatch rev guard dedupes the replay, so re-sending the
  // whole list is safe — order is preserved, and a batch the server already
  // folded in is a no-op there.
  statePatches: StatePatchMessage[]
  done?: DoneMessage
  dropTimer?: ReturnType<typeof setTimeout>
}

// Where a run launches, as the daemon resolved it. `checkout` is set when the
// launch dir is the git worktree the daemon manages for the task (and is then
// also `cwd`).
export type RunPaths = {
  root: string
  cwd: string
  checkout?: string
}

export type RunManagerOptions = {
  // Flow capabilities needed before starting a host, keyed by flow name.
  caps: Partial<Record<string, ProviderCaps>>
  resolveRunPaths: (msg: StartRunMessage, caps: ProviderCaps) => RunPaths
  // Readies the launch dir before spawn — creating the task's checkout — when
  // there is something to do; undefined when there isn't, so the common path
  // still spawns synchronously. A rejection fails the run with its message.
  prepare?: (msg: StartRunMessage, paths: RunPaths) => Promise<void> | undefined
  // What a run's checkout holds as it ends, for its done.
  checkoutReport?: (root: string, dir: string) => Promise<CheckoutReport>
  send: (msg: RunManagerMessage) => void
  // The deterministic per-task file store dir (pure function of the run's
  // project/task). Set as LANDER_FILES_DIR on EVERY turn so `lander attachment`
  // keep reaching a file attached on an earlier turn — the blobs persist there
  // even on turns that carry no new attachment. Sync so the common (no-attachment)
  // path still spawns without an await.
  resolveFilesDir?: (msg: StartRunMessage) => string
  // Materialize a run's attachments into that dir and build the prompt manifest
  // block before spawn. Called only when the start message carries attachments;
  // returns undefined (or is absent) when there's nothing to do.
  materialize?: (
    msg: StartRunMessage,
    opts: { visionNative: boolean },
  ) => Promise<MaterializedFiles | undefined>
  refreshUsage?: () => void | Promise<void>
  runBufferTtlMs?: number
  spawnHost?: SpawnHostLike
  onEmpty?: () => void
  // How long a stopped host gets to exit before its process group is SIGKILLed.
  stopGraceMs?: number
}

const DEFAULT_RUN_BUFFER_TTL_MS = 120_000

// Per git command. The done waits on the checkout report, so a git that hangs
// must not hold the task riding.
const CHECKOUT_REPORT_TIMEOUT_MS = 10_000

export function createRunManager({
  caps,
  resolveRunPaths,
  prepare,
  checkoutReport = (root, dir) =>
    readCheckoutReport(root, dir, gitWithin(CHECKOUT_REPORT_TIMEOUT_MS)),
  send,
  resolveFilesDir,
  materialize,
  refreshUsage = () => {},
  runBufferTtlMs = DEFAULT_RUN_BUFFER_TTL_MS,
  spawnHost = () => spawnHostProcess(HOST_ENTRY),
  onEmpty = () => {},
  stopGraceMs = 2 * HOST_STOP_GRACE_MS,
}: RunManagerOptions): RunManager {
  const runs = new Map<string, Run>()
  // Runs interrupted during the async pre-spawn window (attachment
  // materialization) — before a Run record exists to interrupt. Spawn checks this
  // and aborts cleanly instead of starting a child a human already wedged.
  const preSpawnInterrupts = new Set<string>()
  // Runs accepted but not yet spawned (still in that async window). Counted as
  // held by size() and heldRunIds() — see startRun.
  const pending = new Set<string>()
  // Set by stopAll. From then on nothing spawns: the daemon exits once the
  // hosts it is stopping have closed, and a host spawned meanwhile would be
  // left running.
  let stoppingAll = false

  function done(
    runId: string,
    exitCode: number,
    stderr: string,
    interrupted = false,
  ): void {
    send({ type: 'done', runId, exitCode, interrupted, stderr })
  }

  function startRun(msg: StartRunMessage): void {
    // `flow ?? agent` so a start-run from a server that predates the field still
    // resolves. An unknown name settles the run cleanly rather than throwing —
    // the server's dispatch gate should make this unreachable, but a daemon
    // rolled back below the flow the task names would land here.
    const flow = msg.flow ?? msg.agent
    const known = flow ? caps[flow] : undefined
    if (!known) {
      done(msg.runId, 1, `unsupported flow: ${flow ?? '(none)'}`)
      return
    }
    const activeCaps = known

    let paths: RunPaths
    let prepared: Promise<void> | undefined
    try {
      paths = resolveRunPaths(msg, activeCaps)
      prepared = prepare?.(msg, paths)
    } catch (e) {
      done(msg.runId, 1, e instanceof Error ? e.message : String(e))
      return
    }

    // The common case — no checkout to create, no attachments — spawns
    // synchronously. Otherwise the run takes an async detour first: create the
    // task's checkout, then materialize its attachments (fetch bytes, write
    // LANDER_FILES_DIR, build the manifest block).
    const attachments = !!(msg.attachments?.length && materialize)
    if (!prepared && !attachments) {
      spawnRun(msg, activeCaps, paths, undefined)
      return
    }
    // Held from here until it spawns or settles: no Run record exists during
    // the detour, and without this a drain would see nothing held and exit, and
    // a re-register would leave the run out — so a server that restarted in the
    // window would declare it crashed while it went on to spawn.
    pending.add(msg.runId)
    const failBeforeSpawn = (what: string) => (e: unknown) => {
      preSpawnInterrupts.delete(msg.runId)
      leavePending(msg.runId)
      done(msg.runId, 1, `${what}: ${e instanceof Error ? e.message : String(e)}`)
    }
    void (async () => {
      try {
        await prepared
      } catch (e) {
        return failBeforeSpawn('failed to prepare the task’s worktree')(e)
      }
      let materialized: MaterializedFiles | undefined
      if (attachments)
        try {
          materialized = await materialize!(msg, {
            visionNative: activeCaps.visionNative,
          })
        } catch (e) {
          return failBeforeSpawn('failed to materialize attachments')(e)
        }
      spawnAfterDetour(msg, activeCaps, paths, materialized)
    })()
  }

  // A pending run that ends without spawning leaves nothing else to nudge the
  // drain or the wake hold, so it does that itself.
  function leavePending(runId: string): void {
    if (pending.delete(runId)) onEmpty()
  }

  // The spawn at the end of an async detour runs outside the daemon's per-message
  // try/catch, where a throw would be an unhandled rejection that takes down the
  // daemon and every run it holds. Settle this one run instead, through the same
  // path a synchronous throw takes.
  function spawnAfterDetour(
    msg: StartRunMessage,
    activeCaps: ProviderCaps,
    paths: Parameters<typeof spawnRun>[2],
    materialized: MaterializedFiles | undefined,
  ): void {
    try {
      spawnRun(msg, activeCaps, paths, materialized)
    } catch (e) {
      failRun(msg.runId, `daemon error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function spawnRun(
    msg: StartRunMessage,
    activeCaps: ProviderCaps,
    paths: RunPaths,
    materialized: MaterializedFiles | undefined,
  ): void {
    // A human wedged the task while we were materializing — before a Run record
    // existed to interrupt. Abort cleanly instead of spawning a child they killed.
    if (preSpawnInterrupts.delete(msg.runId)) {
      leavePending(msg.runId)
      done(msg.runId, 0, '', true)
      return
    }
    if (stoppingAll) {
      leavePending(msg.runId)
      send({
        type: 'done',
        runId: msg.runId,
        exitCode: 1,
        interrupted: false,
        stderr: 'daemon stopping; run not started',
        cause: 'daemon-shutdown',
      })
      return
    }

    // The supervisor owns path resolution: LANDER_FILES_DIR points at the
    // persistent per-task store on every turn (so a file attached earlier stays
    // cat-able), falling back to the just-materialized dir if no resolver is wired.
    // Everything the executor needs to run the turn rides in the HostInput.
    const filesDir = resolveFilesDir?.(msg) ?? materialized?.filesDir
    const hostInput: HostInput = {
      start: msg,
      root: paths.root,
      cwd: paths.cwd,
      ...(paths.checkout ? { checkout: paths.checkout } : {}),
      filesDir,
      materialized,
    }

    // Spawn the flow host (its own process group). It reads the HostInput on
    // stdin, runs the flow, and streams neutral HostEvents back on stdout.
    const startedAt = performance.now()
    const host = spawnHost()
    // When the host last produced anything, on the same monotonic clock. This is
    // the run's working time (see DoneMessage.durationMs): it is advanced by the
    // same host output that re-arms the idle watchdog, so "the run did something"
    // means exactly what it means to the watchdog, and a run killed after idling reports the work it did rather than
    // the window it then spent silent.
    let lastOutputAt = startedAt

    // Kill the host's whole process group so the agent grandchild dies with it.
    const killHost = (): void => killProcessGroup(host)
    let closed = false
    const hostClosed = new Promise<void>((resolve) =>
      host.once('close', () => {
        closed = true
        resolve()
      }),
    )

    let seq = 0
    const buffer: UpdateMessage[] = []
    const statePatches: StatePatchMessage[] = []
    let settled = false
    // The activity-armed idle watchdog acts *through* the boundary: it arms on any
    // host output and, on fire, stops the host.
    let timer: ReturnType<typeof setTimeout> | undefined
    const idleWindowMs = msg.idleTimeoutMs
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => stopHost('idle-timeout'), idleWindowMs)
      timer.unref?.()
    }
    // Host output: the run did something. Kept apart from `arm` so the initial arm
    // at the end of this setup doesn't bill the spawn and wiring as working time.
    const sawOutput = () => {
      if (stopReason) return
      lastOutputAt = performance.now()
      arm()
    }

    // Every deliberate stop goes through here. The first one's reason decides
    // how a run not yet settled (fail() settles before it stops) settles when
    // the host closes: as interrupted, or as a failure naming the cause so the
    // server's wedge can say why instead of a generic "run failed". A SIGTERM
    // lets the host stop its agent the agent's own way —
    // Claude ends the background commands and monitors it started, which sit
    // outside the host's process group and would survive killHost — and the host
    // exits once its flow has wound down. A host still alive after stopGraceMs
    // gets killHost.
    let stopReason: 'interrupt' | 'fail' | DoneCause | undefined
    let stopFallback: ReturnType<typeof setTimeout> | undefined
    const stopHost = (reason: NonNullable<typeof stopReason>): void => {
      if (stopReason || closed) return
      stopReason = reason
      if (timer) clearTimeout(timer)
      try {
        host.kill('SIGTERM')
      } catch {}
      stopFallback = setTimeout(killHost, stopGraceMs)
      stopFallback.unref?.()
    }

    // The settle-once `done` gate. A run settles from the first of: a natural
    // done relayed from the executor before any stop, a failed done from fail()
    // or the host's spawn error, or the host closing after a stop or a crash.
    const settle = (d: {
      exitCode: number
      stderr: string
      interrupted: boolean
      cause?: DoneCause
      idleMs?: number
    }): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      const doneMsg: DoneMessage = {
        type: 'done',
        runId: msg.runId,
        exitCode: d.exitCode,
        interrupted: d.interrupted,
        stderr: d.stderr,
        // Measured here rather than at each settle site so every way a run ends
        // is timed the same way. Sent even when it is 0 (a host that produced nothing
        // still worked no time), so only a run that never reaches this gate at
        // all is silent about its duration.
        durationMs: Math.round(lastOutputAt - startedAt),
        ...(d.cause ? { cause: d.cause } : {}),
        ...(d.idleMs ? { idleMs: d.idleMs } : {}),
      }
      // Read here, like durationMs, so every way a run ends reports the state
      // its checkout was left in. A failed read reports nothing about it.
      if (paths.checkout)
        checkoutReport(paths.root, paths.checkout).then(
          (checkout) => finish({ ...doneMsg, checkout }),
          (e) => {
            console.error(`checkout report for ${msg.runId} failed:`, e)
            finish(doneMsg)
          },
        )
      else finish(doneMsg)
    }
    const finish = (doneMsg: DoneMessage): void => {
      rec.done = doneMsg
      rec.dropTimer = setTimeout(() => {
        runs.delete(msg.runId)
        onEmpty()
      }, runBufferTtlMs)
      rec.dropTimer.unref?.()
      send(doneMsg)
      if (activeCaps.usageSnapshot) void refreshUsage()
    }

    // The executor → supervisor seam: assign seq + buffer + relay each event, and
    // (decision 8) fire the usage-refresh trigger off what the update already
    // carries — the first rate-limit reset per run, and every settled done.
    let sawRateLimit = false
    const emit = (event: HostEvent): void => {
      switch (event.kind) {
        case 'session':
          rec.mintedSession = event.sessionId
          send({ type: 'session', runId: msg.runId, sessionId: event.sessionId })
          break
        case 'turn-context':
          rec.sentContext = event.context
          send({ type: 'turn-context', runId: msg.runId, context: event.context })
          break
        case 'update': {
          const update: UpdateMessage = {
            type: 'update',
            runId: msg.runId,
            seq: ++seq,
            steps: event.steps,
            finalText: event.finalText,
            blockedIds: event.blockedIds,
            usage: event.usage,
            usageChanged: event.usageChanged,
            drivingModel: event.drivingModel,
            rateLimitResetsAt: event.rateLimitResetsAt,
            committed: event.committed,
          }
          buffer.push(update)
          send(update)
          if (
            event.rateLimitResetsAt &&
            !sawRateLimit &&
            activeCaps.usageSnapshot
          ) {
            sawRateLimit = true
            void refreshUsage()
          }
          break
        }
        case 'state-patch': {
          // Buffer before sending, so a resume-from can replay it even if the
          // send raced the disconnect that triggered the resume.
          const patch: StatePatchMessage = {
            type: 'state-patch',
            runId: msg.runId,
            ops: event.ops,
            rev: event.rev,
          }
          statePatches.push(patch)
          send(patch)
          break
        }
        case 'done':
          // A stopped run settles from the stop, not from the done its flow
          // reports while it winds down.
          if (stopReason) break
          settle({
            exitCode: event.exitCode,
            stderr: event.stderr,
            interrupted: false,
          })
          break
      }
    }

    const rec: Run = {
      buffer,
      statePatches,
      stop: () => {
        stopHost('daemon-shutdown')
        return hostClosed
      },
      interrupt: () => stopHost('interrupt'),
      fail: (stderr: string) => {
        settle({ exitCode: 1, stderr, interrupted: false })
        stopHost('fail')
      },
    }
    runs.set(msg.runId, rec)
    // The record holds it now; no onEmpty, since nothing was released.
    pending.delete(msg.runId)

    // Hand the host its input as one JSON line on stdin, then close the pipe.
    endStdin(host, JSON.stringify(hostInput) + '\n')

    // Parse the host's stdout as line-JSON HostEvents; every chunk (stdout or the
    // relayed agent stderr) arms the idle watchdog. Route each event into the same
    // supervisor wiring, seq-assigning and buffering updates.
    host.stdout?.on('data', sawOutput)
    onLines(host.stdout, (line) => {
      let event: HostEvent
      try {
        event = JSON.parse(line) as HostEvent
      } catch {
        return
      }
      emit(event)
    })
    host.stderr?.on('data', (d: Buffer) => {
      sawOutput()
      // The host relays agent stderr here (idle activity + diagnostics).
      process.stderr.write(d)
    })
    host.on('error', (e) => {
      // The host failed to spawn — synthesize a failed done.
      settle({
        exitCode: 1,
        stderr: `error spawning flow host: ${e.message}`,
        interrupted: false,
      })
    })
    host.on('close', () => {
      if (stopFallback) clearTimeout(stopFallback)
      if (stopReason === 'interrupt')
        settle({ exitCode: 0, stderr: '', interrupted: true })
      else {
        const cause = stopReason === 'fail' ? undefined : (stopReason ?? 'host-crash')
        settle({
          exitCode: 1,
          stderr: '',
          interrupted: false,
          ...(cause ? { cause } : {}),
          ...(cause === 'idle-timeout' ? { idleMs: idleWindowMs } : {}),
        })
      }
    })

    // Initial arm at spawn (host output re-arms thereafter), matching today's
    // arm-on-start idle countdown.
    arm()
  }

  function interrupt(runId: string): void {
    const run = runs.get(runId)
    if (run) run.interrupt()
    // No Run record yet: the run is still materializing attachments pre-spawn.
    // Remember the interrupt so spawnRun aborts instead of launching the child.
    else preSpawnInterrupts.add(runId)
  }

  function resumeFrom(runId: string, seq: number): void {
    // Still before its spawn: nothing has been sent to replay, and its updates
    // will stream from seq 1 once it starts.
    if (pending.has(runId)) return
    const run = runs.get(runId)
    if (!run) {
      done(
        runId,
        1,
        'daemon has no record of this run (restarted?); run aborted',
      )
      return
    }
    if (run.mintedSession)
      send({ type: 'session', runId, sessionId: run.mintedSession })
    if (run.sentContext)
      send({ type: 'turn-context', runId, context: run.sentContext })
    // Durable-state batches carry no seq of their own — replay them all and let
    // the server's applyStatePatch rev guard drop the ones it already folded in.
    for (const patch of run.statePatches) send(patch)
    for (const update of run.buffer) if (update.seq > seq) send(update)
    if (run.done) send(run.done)
  }

  function ack(runId: string): void {
    const run = runs.get(runId)
    if (run?.dropTimer) clearTimeout(run.dropTimer)
    runs.delete(runId)
    onEmpty()
  }

  function stopAll(): Promise<void> {
    stoppingAll = true
    return Promise.all([...runs.values()].map((run) => run.stop())).then(() => {})
  }

  // Settle a run as failed. If the run was never registered (the throw beat
  // runs.set), there is nothing holding it but a pending entry, so a plain done
  // is correct and cannot bypass a gate that doesn't exist yet.
  function failRun(runId: string, stderr: string): void {
    const rec = runs.get(runId)
    if (rec) rec.fail(stderr)
    else {
      leavePending(runId)
      done(runId, 1, stderr)
    }
  }

  return {
    startRun,
    interrupt,
    resumeFrom,
    ack,
    stopAll,
    failRun,
    heldRunIds: () => [...runs.keys(), ...pending],
    size: () => runs.size + pending.size,
  }
}
