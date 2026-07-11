import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID as nodeRandomUUID } from 'node:crypto'
import type { AgentAdapter } from './agent'
import type { AgentKind } from '../server/protocol'
import type {
  DoneMessage,
  SessionMessage,
  StartRunMessage,
  TurnContextMessage,
  UpdateMessage,
} from '../server/protocol'
import type { MaterializedFiles } from './attachments'
import { runAgent, type HostEvent, type HostInput, type SpawnLike } from './run-agent'

export type RunManagerMessage =
  | UpdateMessage
  | DoneMessage
  | SessionMessage
  | TurnContextMessage

export type RunManager = {
  startRun: (msg: StartRunMessage) => void
  interrupt: (runId: string) => void
  resumeFrom: (runId: string, seq: number) => void
  ack: (runId: string) => void
  killChildren: () => void
  heldRunIds: () => string[]
  size: () => number
}

type Run = {
  interrupt: () => void
  // Kill the executor (the agent child in-process today; the host group later).
  kill: () => void
  buffer: UpdateMessage[]
  mintedSession?: string
  // The dynamic context block appended to this run's prompt (when it changed),
  // re-sent on resume-from — like mintedSession — so a server restart between
  // the announcement and its receipt can't lose the record.
  sentContext?: string
  // step 3: buffer emitted state-patches here and re-send them on resume-from
  // (like sentContext / mintedSession), so a server restart can't lose a flow's
  // durable-state write; the server's applyStatePatch rev guard dedupes the replay.
  // No producer exists in step 1, so there is nothing to buffer yet.
  done?: DoneMessage
  dropTimer?: ReturnType<typeof setTimeout>
}

export type RunManagerOptions = {
  adapters: Partial<Record<AgentKind, AgentAdapter>>
  resolveRunPaths: (
    msg: StartRunMessage,
    adapter: AgentAdapter,
  ) => { root: string; cwd: string }
  send: (msg: RunManagerMessage) => void
  // The deterministic per-task file store dir (pure function of the run's
  // project/task). Set as LANDER_FILES_DIR on EVERY turn so `lander file cat/ls`
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
  defaultIdleMs?: number
  runBufferTtlMs?: number
  spawn?: SpawnLike
  mintSessionId?: () => string
  now?: () => string
  onEmpty?: () => void
}

const DEFAULT_IDLE_MS = 10 * 60_000
const DEFAULT_RUN_BUFFER_TTL_MS = 120_000

export function createRunManager({
  adapters,
  resolveRunPaths,
  send,
  resolveFilesDir,
  materialize,
  refreshUsage = () => {},
  defaultIdleMs = DEFAULT_IDLE_MS,
  runBufferTtlMs = DEFAULT_RUN_BUFFER_TTL_MS,
  spawn = nodeSpawn,
  mintSessionId = nodeRandomUUID,
  now = () => new Date().toISOString(),
  onEmpty = () => {},
}: RunManagerOptions): RunManager {
  const runs = new Map<string, Run>()
  // Runs interrupted during the async pre-spawn window (attachment
  // materialization) — before a Run record exists to interrupt. Spawn checks this
  // and aborts cleanly instead of starting a child a human already wedged.
  const preSpawnInterrupts = new Set<string>()

  function done(
    runId: string,
    exitCode: number,
    stderr: string,
    interrupted = false,
  ): void {
    send({ type: 'done', runId, exitCode, interrupted, stderr })
  }

  function startRun(msg: StartRunMessage): void {
    const adapter = adapters[msg.agent]
    if (!adapter) {
      done(msg.runId, 1, `unsupported agent: ${msg.agent}`)
      return
    }
    const activeAdapter = adapter

    let root: string
    let cwd: string
    try {
      const paths = resolveRunPaths(msg, activeAdapter)
      root = paths.root
      cwd = paths.cwd
    } catch (e) {
      done(msg.runId, 1, e instanceof Error ? e.message : String(e))
      return
    }

    // The common case — no attachments — spawns synchronously. Only a turn that
    // carries attachments takes the async detour to materialize them (fetch
    // bytes, write LANDER_FILES_DIR, build the manifest block) before spawning.
    if (!(msg.attachments?.length && materialize)) {
      spawnRun(msg, activeAdapter, root, cwd, undefined)
      return
    }
    materialize(msg, { visionNative: activeAdapter.attachesImagesToVision }).then(
      (materialized) => spawnRun(msg, activeAdapter, root, cwd, materialized),
      (e) => {
        preSpawnInterrupts.delete(msg.runId)
        done(
          msg.runId,
          1,
          `failed to materialize attachments: ${
            e instanceof Error ? e.message : String(e)
          }`,
        )
      },
    )
  }

  function spawnRun(
    msg: StartRunMessage,
    activeAdapter: AgentAdapter,
    root: string,
    cwd: string,
    materialized: MaterializedFiles | undefined,
  ): void {
    // A human wedged the task while we were materializing — before a Run record
    // existed to interrupt. Abort cleanly instead of spawning a child they killed.
    if (preSpawnInterrupts.delete(msg.runId)) {
      done(msg.runId, 0, '', true)
      return
    }

    // The supervisor owns path resolution: LANDER_FILES_DIR points at the
    // persistent per-task store on every turn (so a file attached earlier stays
    // cat-able), falling back to the just-materialized dir if no resolver is wired.
    // Everything the executor needs to run the turn rides in the HostInput.
    const filesDir = resolveFilesDir?.(msg) ?? materialized?.filesDir
    const hostInput: HostInput = { start: msg, root, cwd, filesDir, materialized }

    let seq = 0
    const buffer: UpdateMessage[] = []
    let settled = false
    // The activity-armed idle watchdog. It kills the executor; the resulting
    // close-without-a-natural-done is settled by the gate as exitCode 1.
    let handle: { kill: () => void } | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => handle?.kill(), msg.idleTimeoutMs || defaultIdleMs)
      timer.unref?.()
    }

    // The settle-once `done` gate — the sole place a done reaches the server,
    // whichever of the three sources fires first: a natural done relayed from the
    // executor, a synthesized interrupt done, or a synthesized close-without-done
    // (idle-kill / crash). Later sources are dropped once settled.
    const settle = (d: {
      exitCode: number
      stderr: string
      interrupted: boolean
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
      }
      rec.done = doneMsg
      rec.dropTimer = setTimeout(() => {
        runs.delete(msg.runId)
        onEmpty()
      }, runBufferTtlMs)
      rec.dropTimer.unref?.()
      send(doneMsg)
      if (activeAdapter.supportsUsageSnapshot) void refreshUsage()
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
          }
          buffer.push(update)
          send(update)
          if (
            event.rateLimitResetsAt &&
            !sawRateLimit &&
            activeAdapter.supportsUsageSnapshot
          ) {
            sawRateLimit = true
            void refreshUsage()
          }
          break
        }
        case 'done':
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
      kill: () => handle?.kill(),
      interrupt: () => {
        // Mirror today's rec.interrupt: settle an interrupted done at once (the
        // gate wins over the executor's kill-triggered natural done), then kill.
        settle({ exitCode: 0, stderr: '', interrupted: true })
        handle?.kill()
      },
    }
    runs.set(msg.runId, rec)

    handle = runAgent(hostInput, {
      emit,
      arm,
      spawn,
      mintSessionId,
      now,
      adapters,
    })
    // Initial arm at spawn (executor data re-arms thereafter), matching today's
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
    for (const update of run.buffer) if (update.seq > seq) send(update)
    if (run.done) send(run.done)
  }

  function ack(runId: string): void {
    const run = runs.get(runId)
    if (run?.dropTimer) clearTimeout(run.dropTimer)
    runs.delete(runId)
    onEmpty()
  }

  function killChildren(): void {
    for (const run of runs.values()) run.kill()
  }

  return {
    startRun,
    interrupt,
    resumeFrom,
    ack,
    killChildren,
    heldRunIds: () => [...runs.keys()],
    size: () => runs.size,
  }
}
