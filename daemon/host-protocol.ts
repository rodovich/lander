// The per-turn flow host's input and output protocol.

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { StartRunMessage, StatePatchOp } from '../server/protocol'
import type { Step, Usage } from '../server/stream'
import type { MaterializedFiles } from './attachments'

export type HostInput = {
  start: StartRunMessage
  root: string
  cwd: string
  // Extra argv the flow needs to reach its intended working state, prepended to
  // the launch (Claude re-enters a worktree with ['--worktree', name]). Empty when
  // the spawn cwd already suffices.
  reentryArgs?: string[]
  // Where the shell lands once reentryArgs apply, if different from cwd (Claude's
  // worktree path) — the dir the git snapshot reads from and the manual-cd hint
  // compares against. Absent when the shell stays in cwd.
  effectiveCwd?: string
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
  // A flow's durable-state write (ctx.state.set/delete/push/patch), batched. The
  // supervisor buffers these on the Run record and re-sends them on resume-from
  // alongside mintedSession/sentContext, then forwards each as a
  // StatePatchMessage; the server's applyStatePatch rev-guard dedupes the replay.
  // `rev` is seeded from StartRunMessage.flowStateRev and incremented per batch,
  // so a later ride's batches always clear that guard.
  //
  // Add event readers before writers: a fresh host loads source from disk while
  // an older supervisor may still be draining existing runs.
  | { kind: 'state-patch'; ops: StatePatchOp[]; rev: number }

export type SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess
