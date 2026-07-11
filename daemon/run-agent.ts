// The adapter *executor* — the half of the old spawnRun that actually runs an
// agent CLI. It picks the compiled-in adapter, assembles the launch (session args,
// per-turn context block, prompt, files-dir env), spawns the agent child, reduces
// its stream-json into neutral events, and reports a natural `done` on close/error.
//
// It talks to its supervisor through two seams: `emit(event)` (session /
// turn-context / seq-less update / natural done) and `arm()` (an activity signal
// for the idle watchdog). In step 2 both are plain function calls — the executor
// runs in the daemon process (see run.ts). In the flow host (a later commit) the
// same code runs in a subprocess: `emit` becomes "write a JSON line to stdout" and
// `arm` becomes "the daemon saw host output". The event shapes below are that
// seam, so they never change between the two transports.
//
// What stays with the *supervisor* (run.ts), not here: seq assignment, the replay
// buffer, resume/ack, the idle timer itself, the settle-once `done` gate, and the
// usage-refresh trigger. This module owns none of that — it only produces events.

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { AgentAdapter } from './agent'
import type { AgentKind, StartRunMessage } from '../server/protocol'
import { addUsage, type Step, type Usage } from '../server/stream'
import type { MaterializedFiles } from './attachments'

// daemon → executor: everything needed to run one turn. The daemon resolves the
// host paths (`root`/`cwd`), the persistent files dir, and materializes any
// attachments before handing this over; the executor does the adapter work. Sent
// as one JSON line on stdin once the executor lives in the flow host.
export type HostInput = {
  start: StartRunMessage
  root: string
  cwd: string
  // LANDER_FILES_DIR — the persistent per-task store, resolved daemon-side (a pure
  // function of project/task, with the just-materialized dir as a fallback).
  filesDir?: string
  materialized?: MaterializedFiles
}

// executor → supervisor: one neutral event per occurrence. Seq-less — the
// supervisor assigns seq and buffers. Emitted as line-JSON on stdout in the host.
export type HostEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'turn-context'; context: string }
  | {
      kind: 'update'
      steps: Step[]
      finalText?: string
      blockedIds?: string[]
      usage?: Usage
      usageChanged: boolean
      drivingModel?: string
      rateLimitResetsAt?: string
    }
  // A NATURAL done — the agent completed, errored, or its stream folded a
  // terminalError. Interrupt and idle-kill dones are synthesized by the supervisor,
  // not emitted here (this executor's `done` is dropped by the settle-once gate
  // when the supervisor already settled). exitCode already accounts for
  // terminalError; stderr is the agent's stderr joined with any terminalError.
  | { kind: 'done'; exitCode: number; stderr: string }

export type SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess

export type RunAgentDeps = {
  emit: (event: HostEvent) => void
  arm: () => void
  spawn?: SpawnLike
  mintSessionId: () => string
  now: () => string
  adapters: Partial<Record<AgentKind, AgentAdapter>>
  // Tee for the agent child's stderr. In-process (run.ts) this is unset — `arm()`
  // already signals idle activity. In the flow host it relays to process.stderr,
  // so agent-only stderr activity (no stdout event) still reaches the daemon's
  // idle watchdog through the boundary (decision 6). runAgent still accumulates
  // stderr for the done event regardless.
  onStderr?: (chunk: string) => void
}

export function runAgent(
  input: HostInput,
  deps: RunAgentDeps,
): { kill: () => void } {
  const { start, root, cwd, materialized } = input
  const {
    emit,
    arm,
    spawn = nodeSpawn,
    mintSessionId,
    now,
    adapters,
    onStderr,
  } = deps

  const adapter = adapters[start.agent]
  if (!adapter) {
    emit({ kind: 'done', exitCode: 1, stderr: `unsupported agent: ${start.agent}` })
    return { kill: () => {} }
  }

  const session = adapter.buildSession({
    sessionId: start.sessionId,
    mintSessionId,
  })
  const taskView = {
    ...start.task,
    agent: start.agent,
    sessionId: start.sessionId,
  }
  // Regenerate the dynamic context block and append it to the outgoing user
  // message when it differs from what the session last received (always, on a
  // fresh session — the server sends no turnContext then).
  const context = adapter.buildTurnContext?.({ task: taskView, root, cwd })
  const sentContext =
    context && context !== start.turnContext ? context : undefined
  // Append the attachment manifest (this turn's files) and the dynamic context
  // block to the user prompt — both ride at the cache-friendly end, after the
  // user's own text.
  const promptParts = [start.prompt]
  if (materialized?.manifestBlock) promptParts.push(materialized.manifestBlock)
  if (sentContext) promptParts.push(sentContext)
  // The daemon already resolved the persistent per-task store dir; expose it as
  // LANDER_FILES_DIR (so `lander file cat/ls` reach files attached on an earlier
  // turn) and hand image paths to the vision channel.
  const filesDir = input.filesDir
  const landerEnv = filesDir
    ? { ...start.env, LANDER_FILES_DIR: filesDir }
    : start.env
  const launch = adapter.buildLaunch({
    task: taskView,
    prompt: promptParts.join('\n\n'),
    root,
    cwd,
    landerEnv,
    images: materialized?.images ?? [],
    // Give the adapter the store dir only when it actually exists (materialized
    // this turn or on an earlier one), so Claude's --add-dir points somewhere real
    // and images stay readable across turns, not just the attaching one.
    filesDir: filesDir && existsSync(filesDir) ? filesDir : undefined,
  })

  const child = spawn(
    adapter.command,
    [...session.args, ...launch.args],
    {
      cwd,
      env: { ...process.env, ...(launch.env ?? start.env) },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let announcedSession = session.announceSession ? session.sessionId : undefined
  if (announcedSession) emit({ kind: 'session', sessionId: announcedSession })
  if (sentContext) emit({ kind: 'turn-context', context: sentContext })

  let liveUsage: Usage | undefined
  let usageInf: string | undefined
  let drivingModel: string | undefined
  let rateLimitResetsAt: string | undefined
  let terminalError: string | undefined
  let buf = ''
  let stderr = ''
  let finished = false

  const flush = (final: boolean): void => {
    if (!buf) return
    const nl = buf.lastIndexOf('\n')
    if (nl < 0 && !final) return
    const chunk = final ? buf : buf.slice(0, nl + 1)
    buf = final ? '' : buf.slice(nl + 1)

    const steps: Step[] = []
    let finalText: string | undefined
    const blockedIds: string[] = []
    let usageChanged = false
    for (const raw of chunk.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      if (!start.sessionId && !announcedSession) {
        const sessionId = adapter.extractSession?.(line)
        if (sessionId) {
          announcedSession = sessionId
          emit({ kind: 'session', sessionId })
        }
      }
      const r = adapter.reduceLine(line, now())
      if (r.drivingModel) drivingModel = r.drivingModel
      const reliableReset = adapter.supportsRateLimitRetryScheduling
        ? r.rateLimitResetsAt
        : undefined
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
          // The result event's total is authoritative for the counts but carries
          // no diagnostics — keep the streamed cache-miss record.
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
      emit({
        kind: 'update',
        steps,
        finalText,
        blockedIds,
        usage: usageChanged ? liveUsage : undefined,
        usageChanged,
        drivingModel,
        rateLimitResetsAt,
      })
    }
  }

  const finishNatural = (exitCode: number): void => {
    if (finished) return
    finished = true
    flush(true)
    const doneStderr = [stderr.trim(), terminalError?.trim()]
      .filter(Boolean)
      .join('\n')
    emit({
      kind: 'done',
      // A clean exit that nonetheless folded a terminalError reports as failed.
      exitCode: exitCode === 0 && terminalError ? 1 : exitCode,
      stderr: doneStderr,
    })
  }

  child.stdout?.on('data', (d: Buffer) => {
    arm()
    buf += d.toString()
    flush(false)
  })
  child.stderr?.on('data', (d: Buffer) => {
    arm()
    const text = d.toString()
    stderr += text
    onStderr?.(text)
  })
  child.on('error', (e) => {
    stderr += `error running assistant: ${e.message}`
    finishNatural(1)
  })
  child.on('close', (code) => finishNatural(code == null ? 1 : code))

  return {
    kill: () => {
      try {
        child.kill('SIGKILL')
      } catch {}
    },
  }
}
