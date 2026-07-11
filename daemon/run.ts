import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
import { existsSync } from 'node:fs'
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
import { addUsage, type Usage } from '../server/stream'
import type { MaterializedFiles } from './attachments'

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

type SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess

type Run = {
  interrupt: () => void
  child: ChildProcess
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

    const session = activeAdapter.buildSession({
      sessionId: msg.sessionId,
      mintSessionId,
    })
    const taskView = {
      ...msg.task,
      agent: msg.agent,
      sessionId: msg.sessionId,
    }
    // Regenerate the dynamic context block and append it to the outgoing user
    // message when it differs from what the session last received (always, on a
    // fresh session — the server sends no turnContext then). Announced below so
    // the server records the new baseline.
    const context = activeAdapter.buildTurnContext?.({ task: taskView, root, cwd })
    const sentContext =
      context && context !== msg.turnContext ? context : undefined
    // Append the attachment manifest (this turn's files) and the dynamic context
    // block to the user prompt — both ride at the cache-friendly end, after the
    // user's own text. Expose LANDER_FILES_DIR so `lander file cat/ls` can read
    // the materialized store, and hand image paths to the vision channel.
    const promptParts = [msg.prompt]
    if (materialized?.manifestBlock) promptParts.push(materialized.manifestBlock)
    if (sentContext) promptParts.push(sentContext)
    // LANDER_FILES_DIR points at the persistent per-task store on every turn (so a
    // file attached earlier stays cat-able), falling back to the just-materialized
    // dir if no resolver is wired.
    const filesDir = resolveFilesDir?.(msg) ?? materialized?.filesDir
    const landerEnv = filesDir
      ? { ...msg.env, LANDER_FILES_DIR: filesDir }
      : msg.env
    const launch = activeAdapter.buildLaunch({
      task: taskView,
      prompt: promptParts.join('\n\n'),
      root,
      cwd,
      landerEnv,
      images: materialized?.images ?? [],
      // Give the adapter the store dir only when it actually exists (materialized
      // this turn or on an earlier one), so Claude's --add-dir points somewhere
      // real and images stay readable across turns, not just the attaching one.
      filesDir: filesDir && existsSync(filesDir) ? filesDir : undefined,
    })

    const child: ChildProcess = spawn(
      activeAdapter.command,
      [...session.args, ...launch.args],
      {
        cwd,
        env: { ...process.env, ...(launch.env ?? msg.env) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let announcedSession = session.announceSession ? session.sessionId : undefined
    if (announcedSession)
      send({ type: 'session', runId: msg.runId, sessionId: announcedSession })
    if (sentContext)
      send({ type: 'turn-context', runId: msg.runId, context: sentContext })

    let seq = 0
    const buffer: UpdateMessage[] = []
    let liveUsage: Usage | undefined
    let usageInf: string | undefined
    let drivingModel: string | undefined
    let rateLimitResetsAt: string | undefined
    let terminalError: string | undefined
    let sawRateLimit = false
    let buf = ''
    let stderr = ''
    let settled = false
    let interrupted = false

    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, msg.idleTimeoutMs || defaultIdleMs)
      timer.unref?.()
    }

    const rec: Run = {
      child,
      buffer,
      mintedSession: announcedSession,
      sentContext,
      interrupt: () => {
        interrupted = true
        try {
          child.kill('SIGKILL')
        } catch {}
        finish(0)
      },
    }
    runs.set(msg.runId, rec)
    arm()

    const flush = (final: boolean): void => {
      if (!buf) return
      const nl = buf.lastIndexOf('\n')
      if (nl < 0 && !final) return
      const chunk = final ? buf : buf.slice(0, nl + 1)
      buf = final ? '' : buf.slice(nl + 1)

      const steps: UpdateMessage['steps'] = []
      let finalText: string | undefined
      const blockedIds: string[] = []
      let usageChanged = false
      for (const raw of chunk.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        if (!msg.sessionId && !announcedSession) {
          const sessionId = activeAdapter.extractSession?.(line)
          if (sessionId) {
            announcedSession = sessionId
            rec.mintedSession = sessionId
            send({ type: 'session', runId: msg.runId, sessionId })
          }
        }
        const r = activeAdapter.reduceLine(line, now())
        if (r.drivingModel) drivingModel = r.drivingModel
        const reliableReset = activeAdapter.supportsRateLimitRetryScheduling
          ? r.rateLimitResetsAt
          : undefined
        if (reliableReset && !sawRateLimit) {
          sawRateLimit = true
          if (activeAdapter.supportsUsageSnapshot) void refreshUsage()
        }
        if (reliableReset) rateLimitResetsAt = reliableReset
        if (r.terminalError) {
          if (!terminalError) terminalError = r.terminalError
          else if (!terminalError.includes(r.terminalError))
            terminalError += `\n${r.terminalError}`
        }
        steps.push(...r.steps)
        if (r.finalText !== undefined) finalText = r.finalText
        if (r.blockedIds) blockedIds.push(...r.blockedIds)
        if (r.usage) {
          if (r.usageFinal) {
            // The result event's total is authoritative for the counts but
            // carries no diagnostics — keep the streamed cache-miss record.
            liveUsage = liveUsage?.cacheMiss
              ? { ...r.usage, cacheMiss: liveUsage.cacheMiss }
              : r.usage
            usageChanged = true
          } else if (r.usageInferenceId !== usageInf) {
            usageInf = r.usageInferenceId
            liveUsage = addUsage(liveUsage, r.usage)
            usageChanged = true
          }
        }
      }

      if (
        steps.length ||
        finalText !== undefined ||
        blockedIds.length ||
        usageChanged
      ) {
        const update: UpdateMessage = {
          type: 'update',
          runId: msg.runId,
          seq: ++seq,
          steps,
          finalText,
          blockedIds,
          usage: usageChanged ? liveUsage : undefined,
          usageChanged,
          drivingModel,
          rateLimitResetsAt,
        }
        buffer.push(update)
        send(update)
      }
    }

    function finish(exitCode: number): void {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      flush(true)
      const doneStderr = [stderr.trim(), terminalError?.trim()]
        .filter(Boolean)
        .join('\n')
      const doneMsg: DoneMessage = {
        type: 'done',
        runId: msg.runId,
        exitCode: exitCode === 0 && terminalError && !interrupted ? 1 : exitCode,
        interrupted,
        stderr: doneStderr,
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

    child.stdout?.on('data', (d: Buffer) => {
      arm()
      buf += d.toString()
      flush(false)
    })
    child.stderr?.on('data', (d: Buffer) => {
      arm()
      stderr += d.toString()
    })
    child.on('error', (e) => {
      stderr += `error running assistant: ${e.message}`
      finish(1)
    })
    child.on('close', (code) => finish(code == null ? 1 : code))
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
    for (const run of runs.values()) {
      try {
        run.child.kill('SIGKILL')
      } catch {}
    }
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
