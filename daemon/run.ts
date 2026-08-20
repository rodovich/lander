import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import type { ProviderCaps } from './flows/index'
import type { AgentKind } from '../server/protocol'
import type {
  DoneCause,
  DoneMessage,
  SessionMessage,
  StartRunMessage,
  StatePatchMessage,
  TurnContextMessage,
  UpdateMessage,
} from '../server/protocol'
import type { MaterializedFiles } from './attachments'
import { ROOT } from './adapters'
import type { HostEvent, HostInput } from './run-agent'

// Spawn a flow host for one run. Injectable so tests substitute a fake host
// without spawning a real `tsx`; the default runs the compiled-in host entry.
export type SpawnHostLike = () => ChildProcess

// The host entry, resolved absolutely so the host process's own cwd is free to be
// the repo root while the *agent* runs in the run's cwd (carried in the HostInput).
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
  killChildren: () => void
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
  // Kill the executor (the agent child in-process today; the host group later).
  kill: () => void
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

export type RunManagerOptions = {
  // What the supervisor needs to know about a provider before the host starts:
  // where to launch, how images reach vision, whether it owns the usage panel.
  // Answered by a flow or by a compiled adapter — the supervisor is written
  // against the one shape either way, so a cutover never reaches in here.
  // Keyed by flow name — an adapter-less flow has no AgentKind to be keyed by.
  caps: Partial<Record<string, ProviderCaps>>
  resolveRunPaths: (
    msg: StartRunMessage,
    caps: ProviderCaps,
  ) => { root: string; cwd: string; reentryArgs: string[]; effectiveCwd?: string }
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
  // Execution now lives in a per-run flow-host subprocess; the daemon supervises
  // it (seq, buffer, resume, idle, interrupt, done gate) but no longer spawns the
  // agent, mints sessions, or reduces streams itself — the host does. Session
  // minting and stream timestamps moved into the host with runAgent.
  spawnHost?: SpawnHostLike
  onEmpty?: () => void
}

// Fallback idle window, outranked by the daemon's own defaultIdleMs and by the
// server's per-run idleTimeoutMs; server/index.ts states the constraint any
// operative value has to meet.
const DEFAULT_IDLE_MS = 15 * 60_000
const DEFAULT_RUN_BUFFER_TTL_MS = 120_000

export function createRunManager({
  caps,
  resolveRunPaths,
  send,
  resolveFilesDir,
  materialize,
  refreshUsage = () => {},
  defaultIdleMs = DEFAULT_IDLE_MS,
  runBufferTtlMs = DEFAULT_RUN_BUFFER_TTL_MS,
  spawnHost = () =>
    nodeSpawn('tsx', [HOST_ENTRY], {
      // The host lives in its own process group (detached) so interrupt / idle /
      // killChildren signal the *group* (`process.kill(-pid)`) and take the agent
      // grandchild down with it — no orphans. cwd is the repo root; the agent's
      // real cwd rides in the HostInput. The host inherits the daemon env (env
      // scrubbing is a later step).
      cwd: ROOT,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    }),
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

    let paths: {
      root: string
      cwd: string
      reentryArgs: string[]
      effectiveCwd?: string
    }
    try {
      paths = resolveRunPaths(msg, activeCaps)
    } catch (e) {
      done(msg.runId, 1, e instanceof Error ? e.message : String(e))
      return
    }

    // The common case — no attachments — spawns synchronously. Only a turn that
    // carries attachments takes the async detour to materialize them (fetch
    // bytes, write LANDER_FILES_DIR, build the manifest block) before spawning.
    if (!(msg.attachments?.length && materialize)) {
      spawnRun(msg, activeCaps, paths, undefined)
      return
    }
    materialize(msg, { visionNative: activeCaps.visionNative }).then(
      (materialized) => spawnRun(msg, activeCaps, paths, materialized),
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
    activeCaps: ProviderCaps,
    paths: {
      root: string
      cwd: string
      reentryArgs: string[]
      effectiveCwd?: string
    },
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
    const hostInput: HostInput = {
      start: msg,
      root: paths.root,
      cwd: paths.cwd,
      reentryArgs: paths.reentryArgs,
      ...(paths.effectiveCwd ? { effectiveCwd: paths.effectiveCwd } : {}),
      filesDir,
      materialized,
    }

    // Spawn the flow host (its own process group). It reads the HostInput on
    // stdin, runs the adapter, and streams neutral HostEvents back on stdout.
    const host = spawnHost()

    // Kill the host's whole process group so the agent grandchild dies with it —
    // falling back to a plain pid kill if the group signal isn't available.
    const killHost = (): void => {
      try {
        if (host.pid) process.kill(-host.pid, 'SIGKILL')
        else host.kill('SIGKILL')
      } catch {
        try {
          host.kill('SIGKILL')
        } catch {}
      }
    }

    let seq = 0
    const buffer: UpdateMessage[] = []
    const statePatches: StatePatchMessage[] = []
    let settled = false
    // Why we killed the host, when we did — stamped onto the synthesized
    // close-without-done so the server can name the cause instead of wedging
    // with a generic "run failed" that's indistinguishable from a crash.
    let endCause: DoneCause | undefined
    // The activity-armed idle watchdog acts *through* the boundary: it arms on any
    // host output and, on fire, kills the host group. The resulting
    // close-without-a-natural-done is settled by the gate as exitCode 1.
    let timer: ReturnType<typeof setTimeout> | undefined
    const idleWindowMs = msg.idleTimeoutMs || defaultIdleMs
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        endCause ??= 'idle-timeout'
        killHost()
      }, idleWindowMs)
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
        ...(d.cause ? { cause: d.cause } : {}),
        ...(d.idleMs ? { idleMs: d.idleMs } : {}),
      }
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
      kill: () => {
        // A daemon shutdown (killChildren) is a deliberate platform stop, not a
        // crash — record it so the synthesized done names the right cause. An
        // already-set cause (the watchdog fired first) wins.
        endCause ??= 'daemon-shutdown'
        killHost()
      },
      interrupt: () => {
        // Mirror today's interrupt: settle an interrupted done at once (the gate
        // wins over the host's kill-triggered close), then kill the host group.
        settle({ exitCode: 0, stderr: '', interrupted: true })
        killHost()
      },
      fail: (stderr: string) => {
        settle({ exitCode: 1, stderr, interrupted: false })
        killHost()
      },
    }
    runs.set(msg.runId, rec)

    // Hand the host its input as one JSON line on stdin, then close the pipe.
    host.stdin?.on('error', () => {})
    try {
      host.stdin?.write(JSON.stringify(hostInput) + '\n')
      host.stdin?.end()
    } catch {}

    // Parse the host's stdout as line-JSON HostEvents; every chunk (stdout or the
    // relayed agent stderr) arms the idle watchdog. Route each event into the same
    // supervisor wiring, seq-assigning and buffering updates.
    let buf = ''
    host.stdout?.on('data', (d: Buffer) => {
      arm()
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let event: HostEvent
        try {
          event = JSON.parse(line) as HostEvent
        } catch {
          continue
        }
        emit(event)
      }
    })
    host.stderr?.on('data', (d: Buffer) => {
      arm()
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
      // A natural done (or a synthesized interrupt done) already settled the run.
      // Otherwise the host was killed (idle timeout / daemon shutdown) or crashed
      // without emitting one — synthesize the failed done, naming which, so the
      // server's wedge can say why instead of the generic "run failed".
      if (!settled)
        settle({
          exitCode: 1,
          stderr: '',
          interrupted: false,
          cause: endCause ?? 'host-crash',
          ...(endCause === 'idle-timeout' ? { idleMs: idleWindowMs } : {}),
        })
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

  function killChildren(): void {
    for (const run of runs.values()) run.kill()
  }

  return {
    startRun,
    interrupt,
    resumeFrom,
    ack,
    killChildren,
    // Settle a run as failed. If the run was never registered (the throw beat
    // runs.set), there is nothing holding it, so a plain done is correct and
    // cannot bypass a gate that doesn't exist yet.
    failRun: (runId: string, stderr: string): void => {
      const rec = runs.get(runId)
      if (rec) rec.fail(stderr)
      else done(runId, 1, stderr)
    },
    heldRunIds: () => [...runs.keys()],
    size: () => runs.size,
  }
}
