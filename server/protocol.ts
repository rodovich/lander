// The shared message contract for the daemon ⇄ server WebSocket link. Types
// only: the daemon and server exchange these shapes as the run lifecycle crosses
// the network. It must not import index.ts or carry any runtime logic.

import type { Step, Usage } from './stream'

export type AgentKind = 'claude' | 'codex'

// One window of the OAuth usage payload, as the server caches and serves it.
export type UsageWindow = { utilization: number; resetsAt: string | null }

// The cached usage snapshot: the session and weekly windows (either null when the
// account API didn't report it).
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
  // The provider that should run this turn. Claude is the only implemented
  // launcher today; Codex support will add its adapter behind this field.
  agent: AgentKind
  // The project slug; the daemon maps it to a host path.
  project: string
  // cwd hints — the recorded task.cwd and whether the run wants its worktree. The
  // daemon does the stat/fallback/worktree resolution locally.
  recordedCwd?: string
  worktree?: string
  // The provider session to resume, when the task already has one (a prior turn
  // reported it — see SessionMessage). Absent on a task's first turn. For Claude
  // today, the daemon mints a fresh session id, launches with `--session-id`, and
  // reports it back for the server to persist and pass here (→ `--resume`) on
  // later turns. This decouples the lander task id (a short nanoid the server
  // owns) from the provider session id.
  sessionId?: string
  agentArgs: string[]
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
  // True while the daemon is draining for a handoff — finishing its riding turns
  // and taking no new ones. The server keeps a draining daemon off new runs (it
  // stays owner of the runs it already holds). Absent/false for a normal daemon.
  draining?: boolean
  // The run-ids this daemon currently holds, sent on every (re)connect so the
  // server rebuilds run ownership from reality and resumes each run only on its
  // true holder (never aborting it on a daemon that doesn't hold it). Omitted by a
  // pre-announcement daemon — which the server then treats the legacy way (assume
  // it holds every open run); an empty array means it genuinely holds none.
  runs?: string[]
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

// The provider session id learned for a task's first turn. For Claude today, the
// daemon mints it before spawning the child; future providers may report it from
// their stream. Sent once so the server can persist it on the task and pass it
// back as `sessionId` on every later turn. The daemon also holds it on the run
// record and re-sends it on resume-from, so a reconnect mid-first-turn doesn't
// lose it. The daemon never informs the agent of it.
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
