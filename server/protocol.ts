// The shared message contract for the daemon ⇄ server WebSocket link (see
// docs/daemon-server-split-plan.md, "Wire protocol"). Types only: this module is
// pure dead code today — it defines the shapes both sides will exchange once the
// run lifecycle moves across the network, and is wired up by later steps. It must
// not import index.ts or carry any runtime logic.

import type { Step, Usage } from './stream'

// One window of the OAuth usage payload, as the server caches and serves it. A
// duplicate of the same-named type in server/index.ts for now — this step is
// behavior-preserving, so index.ts keeps its own copy and a later step
// reconciles them onto this shared definition.
export type UsageWindow = { utilization: number; resetsAt: string | null }

// The cached usage snapshot: the session and weekly windows (either null when the
// account API didn't report it). Mirrors `UsageBody` in server/index.ts.
export type UsageBody = { session: UsageWindow | null; weekly: UsageWindow | null }

// ── Server → daemon ────────────────────────────────────────────────────────

// Launch a run: like today's RunJob minus the file paths and the absolute cwd.
// The server sends the project slug plus cwd hints (the recorded task cwd and the
// worktree flag) and the daemon resolves the actual directory from the host paths
// it owns (decision 8).
export type StartRunMessage = {
  type: 'start-run'
  runId: string
  taskId: string
  // The project slug; the daemon maps it to a host path.
  project: string
  // cwd hints — the recorded task.cwd and whether the run wants its worktree. The
  // daemon does the stat/fallback/worktree resolution locally.
  recordedCwd?: string
  worktree?: string
  claudeArgs: string[]
  env: Record<string, string>
  idleTimeoutMs: number
}

// Interrupt a run now (a human wedged the task); the daemon SIGKILLs the child
// and emits a `done { interrupted: true }`.
export type InterruptMessage = {
  type: 'interrupt'
  runId: string
}

// On reconnect, the server tells the daemon the last seq it applied for a live
// run; the daemon replays buffered updates after `seq`.
export type ResumeFromMessage = {
  type: 'resume-from'
  runId: string
  seq: number
}

export type ServerToDaemon =
  | StartRunMessage
  | InterruptMessage
  | ResumeFromMessage

// ── Daemon → server ────────────────────────────────────────────────────────

// On connect (and on change), the daemon announces which project slugs it serves
// so the server can organize data dirs / `/api/projects`. Slug derivation is the
// daemon's job; the server only ever sees slugs.
export type RegisterMessage = {
  type: 'register'
  projects: { slug: string }[]
}

// A structured run update — exactly the fields `reduceStreamLine` produces, plus
// the monotonic `seq` that keys idempotent apply/replay. `steps` is the activity
// it contributes; the optional fields mirror the reducer's return.
export type UpdateMessage = {
  type: 'update'
  runId: string
  seq: number
  steps: Step[]
  finalText?: string
  blockedIds?: string[]
  usage?: Usage
  // The inference id `usage` belongs to when it's an assistant event's
  // per-inference snapshot; absent on a result event's authoritative total.
  usageInferenceId?: string
  // True when `usage` is the result event's authoritative turn total (replaces
  // the running estimate rather than adding to it).
  usageFinal?: boolean
  drivingModel?: string
  rateLimitResetsAt?: string
}

// The run finished. Sent with retry/replay until the server acks; a `done` for an
// already-done run is a no-op (idempotency by runId).
export type DoneMessage = {
  type: 'done'
  runId: string
  exitCode: number
  interrupted: boolean
  stderr: string
}

// A fresh usage snapshot, pushed whenever the daemon refreshes (per-turn, on the
// reset timer, at boot). Not tied to any run; the server caches and serves it
// verbatim. Carries the same `UsageBody` shape (session + weekly windows).
export type UsageMessage = {
  type: 'usage'
  session: UsageWindow | null
  weekly: UsageWindow | null
}

export type DaemonToServer =
  | RegisterMessage
  | UpdateMessage
  | DoneMessage
  | UsageMessage
