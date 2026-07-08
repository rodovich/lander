import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
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
  refreshUsage = () => {},
  defaultIdleMs = DEFAULT_IDLE_MS,
  runBufferTtlMs = DEFAULT_RUN_BUFFER_TTL_MS,
  spawn = nodeSpawn,
  mintSessionId = nodeRandomUUID,
  now = () => new Date().toISOString(),
  onEmpty = () => {},
}: RunManagerOptions): RunManager {
  const runs = new Map<string, Run>()

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
    const launch = activeAdapter.buildLaunch({
      task: taskView,
      prompt: sentContext ? `${msg.prompt}\n\n${sentContext}` : msg.prompt,
      root,
      cwd,
      landerEnv: msg.env,
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
    runs.get(runId)?.interrupt()
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
