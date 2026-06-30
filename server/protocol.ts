// The shared message contract for the daemon ⇄ server WebSocket link. Types
// only: this module is
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
  // The assistant session to resume, when the task already has one (a prior turn
  // minted it — see SessionMessage). Absent on a task's first turn: the daemon
  // mints a fresh session id, launches with `--session-id`, and reports it back
  // for the server to persist and pass here (→ `--resume`) on later turns. This
  // is what decouples the lander task id (a short nanoid the server owns) from
  // the assistant session id (a uuid the daemon owns).
  sessionId?: string
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
// run; the daemon replays buffered updates after `seq` (and re-sends `done` if
// the run already finished). A run the daemon no longer holds (it restarted —
// decision 2) is answered with an aborting `done`.
export type ResumeFromMessage = {
  type: 'resume-from'
  runId: string
  seq: number
}

// The server has applied a run's `done`; the daemon may drop that run's replay
// buffer. Until this lands the daemon retains the buffer (so a reconnect can
// replay), bounded by a timeout so a lost ack can't leak it forever.
export type AckMessage = {
  type: 'ack'
  runId: string
}

export type ServerToDaemon =
  | StartRunMessage
  | InterruptMessage
  | ResumeFromMessage
  | AckMessage

// ── Daemon → server ────────────────────────────────────────────────────────

// On connect (and on change), the daemon announces which project slugs it serves
// so the server can organize data dirs / `/api/projects`. Slug derivation is the
// daemon's job; the server only ever sees slugs.
export type RegisterMessage = {
  type: 'register'
  projects: { slug: string }[]
}

// A structured run update — one reduced batch of stream output, plus the
// monotonic `seq` that keys idempotent apply/replay. The daemon owns the
// reduction (reduceStreamLine + the cross-line accumulation that used to live in
// reduceRun), so it sends the *resolved* running usage and a `usageChanged` flag
// rather than the per-line inference id / final marker — this lines the message
// up 1:1 with apply.ts's `ApplyUpdate` (the server maps `seq` → its run cursor
// and folds it straight on with `applyUpdate`). `steps` is the activity the batch
// contributes; the rest mirror the accumulator's resolved state.
export type UpdateMessage = {
  type: 'update'
  runId: string
  seq: number
  steps: Step[]
  finalText?: string
  blockedIds?: string[]
  // The run's accumulated token usage (summed across inferences, replaced by the
  // result event's authoritative total) — present only when `usageChanged`.
  usage?: Usage
  // Whether this batch moved usage; the server stores `usage` only when set.
  usageChanged: boolean
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

// The assistant session id the daemon minted for a task's first turn (it owns
// session-id generation now — decision: tasks are decoupled from sessions). Sent
// once, right after the child spawns, so the server can persist it on the task
// and pass it back as `sessionId` (→ `--resume`) on every later turn. The daemon
// also holds it on the run record and re-sends it on resume-from, so a reconnect
// mid-first-turn doesn't lose it. The daemon never informs the agent of it.
export type SessionMessage = {
  type: 'session'
  runId: string
  sessionId: string
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
  | SessionMessage
  | UsageMessage
